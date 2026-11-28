import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join, posix, win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isAgent, validPolicy, validSessionId} from '../../../packages/protocol/orchestration.ts';
import type {AgentKind, AgentRuntimeAdapter, DispatchRecord, DispatchPolicy, DispatchRequest, RuntimeTurn, SessionRef} from '../../../packages/protocol/orchestration.ts';

type Target = DispatchRequest['to'];
type Submission = Parameters<AgentRuntimeAdapter['startTurn']>[0];
type Decision = Parameters<AgentRuntimeAdapter['answerApproval']>[2];
type RecordState = DispatchRecord & {sourceJob?: string; interruptSent?: boolean};
interface State {policy: DispatchPolicy; bindings: Record<string,SessionRef>; records: RecordState[]}
type Question = {question: string; commandReview?: object; fileReview?: object; options?: {label: string}[]};
type CodexBridge = Omit<AgentRuntimeAdapter,'getTurnStatus'|'cancelTurn'> & {
  getTurnStatus(id: string): Promise<RuntimeTurn & {inputRequests?: Record<string, Question[]>}>;
  cancelTurn(id: string): Promise<unknown>;
};
interface AcpItem {archived?: boolean; cwd?: string; path?: string; conversationId?: string; session?: string; title?: string}
interface AcpRequest {
  (action:'sessions', body:object): Promise<{items:AcpItem[]}>;
  (action:'status', body:object): Promise<RuntimeTurn>;
  (action:'stop'|'cancel-queued'|'answer'|'submit', body:object): Promise<unknown>;
}
interface Options {
  codexBridge: CodexBridge;
  antigravity: AcpRequest;
  stateDir: string | URL;
  onEvent?: (type:'dispatch.updated'|'policy.updated', data:DispatchRecord|DispatchPolicy)=>void;
  interval?: number;
}
function runtimeError(error: unknown) {
  return (error instanceof Error?error:Error(String(error))) as Error & {httpStatus?: number; code?: string};
}
const terminal = new Set(['done','stopped','failed','rejected']);
const stopped = new Set(['paused','stopped','interrupted','cancelled']);
const defaults: DispatchPolicy = {mode:'confirm', maxHops:3, singleWriterLock:true};
function requireValue(ok: unknown, message: string, httpStatus=400): asserts ok {
  if (!ok) throw Object.assign(Error(message), {httpStatus});
}
export function workspaceKey(cwd: unknown) {
  requireValue(typeof cwd==='string' && cwd.length<=4096 && !/[\x00-\x1f]/.test(cwd), '无效项目目录');
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(cwd))
    return win32.normalize(cwd).replaceAll('\\','/').toLowerCase().replace(/\/+$/,'');
  requireValue(posix.isAbsolute(cwd), '需要主机项目的绝对路径');
  return posix.normalize(cwd).replace(/\/+$/,'') || '/';
}
function ref(input: SessionRef): SessionRef;
function ref(input: Target, optional: true): Target;
function ref(input: Target, optional=false): Target {
  requireValue(input && isAgent(input.agent), '无效助手');
  workspaceKey(input.cwd);
  requireValue(optional && input.sessionId==null || validSessionId(input.agent,input.sessionId), '无效会话 ID');
  requireValue(input.projectId==null || typeof input.projectId==='string' && input.projectId.length<=256, '无效项目 ID');
  return {agent:input.agent,cwd:input.cwd,sessionId:input.sessionId??null,projectId:input.projectId??null};
}
function directive(text?: string) {
  const match=/(?:^|\n)```orchestrator-dispatch[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text||'');
  if (!match) return;
  try {return JSON.parse(match[1])} catch {return}
}
function receipt(record: DispatchRecord,job: RuntimeTurn) {
  const items=job.progress?.items || (job.rows||[]).flatMap(row=>row.items||[]);
  const tools=items.filter(i=>i.type!=='agyThought').slice(-8).map(i=>({
    tool:String(i.title||i.command||i.type).slice(0,160),status:i.status,exitCode:i.exitCode,
    files:(i.locations||i.changes?.map(change=>change.path)||[]).slice(0,8).map(p=>String(p).slice(0,140))
  }));
  // Include whole JSON fields even when the host returns very large UTF-8 strings.
  let answer=String(job.answer??job.text??'').slice(-2800);
  for (;;) {
    const result=JSON.stringify({dispatchId:record.id,objective:record.objective,status:'done',answer,tools});
    if (Buffer.byteLength(result)<=15000) return result;
    if (tools.length) tools.pop(); else answer=answer.slice(Math.ceil(answer.length/2));
  }
}

export class AntigravityAdapter implements AgentRuntimeAdapter {
  request;
  constructor(request: AcpRequest) {this.request=request}
  async sessions({cwd}: Pick<SessionRef,'cwd'>): Promise<SessionRef[]> {
    const {items}=await this.request('sessions',{cwd});
    return items.filter(i=>!i.archived).map(i=>({agent:'antigravity',cwd:i.cwd||i.path||cwd,
      sessionId:i.conversationId||i.session||'',title:i.title}));
  }
  startTurn({id,cwd,sessionId,prompt,model,mode}: Submission) {
    return this.request('submit',{id,cwd,session:sessionId,prompt,model,mode,queue:true,orchestrated:true});
  }
  getTurnStatus(id: string) {return this.request('status',{id})}
  cancelTurn(id: string,job: RuntimeTurn) {return this.request(job.status==='queued'?'cancel-queued':'stop',{id})}
  answerApproval(id: string,token: string,decision: Decision) {return this.request('answer',{id,token,decision})}
}
export class CodexAdapter implements AgentRuntimeAdapter {
  bridge;
  constructor(bridge: CodexBridge) {this.bridge=bridge}
  sessions(target: Target) {return this.bridge.sessions(target)}
  startTurn(input: Submission) {return this.bridge.startTurn(input)}
  async getTurnStatus(id: string) {
    const job=await this.bridge.getTurnStatus(id),pending=Object.entries(job.inputRequests||{})[0];
    if(!pending)return job;
    const [token,questions]=pending,q=questions[0],review=q.commandReview||q.fileReview;
    return {...job,approval:{token,title:q.question,detail:JSON.stringify(review||questions).slice(0,4096),
      canAnswer:!!review && q.options?.some(o=>o.label==='仅允许本次')}};
  }
  cancelTurn(id: string) {return this.bridge.cancelTurn(id)}
  answerApproval(id: string,token: string,decision: Decision) {return this.bridge.answerApproval(id,token,decision)}
}

// All state transitions, including model-initiated dispatches, use one writer per device.
// Stable submission IDs are committed before either adapter can contact the host.
export async function createOrchestrator({codexBridge,antigravity,stateDir,onEvent=()=>{},interval=650}: Options) {
  const adapters: Record<AgentKind,AgentRuntimeAdapter>={codex:new CodexAdapter(codexBridge),antigravity:new AntigravityAdapter(antigravity)};
  const folder=join(stateDir instanceof URL?fileURLToPath(stateDir):stateDir,'orchestrator');
  const path=join(folder,'state.json');
  await mkdir(folder,{recursive:true});
  let state: State={policy:{...defaults},bindings:{},records:[]};
  try {state=JSON.parse(await readFile(path,'utf8'))} catch(error) {const e=runtimeError(error);if(e.code!=='ENOENT')throw e}
  let checkpoint=JSON.stringify(state);
  let tail: Promise<unknown>=Promise.resolve(),timer: NodeJS.Timeout | undefined,closed=false;
  function serialized<T>(work: ()=>Promise<T>) {
    const result=tail.then(work);
    tail=result.catch(()=>{});
    return result;
  }
  async function commit(type: 'dispatch.updated'|'policy.updated',data: DispatchRecord|DispatchPolicy) {
    const tmp=join(folder,randomUUID()+'.tmp');
    const next=JSON.stringify(state);
    try {
      await writeFile(tmp,next,{mode:0o600});await rename(tmp,path);
    } catch(error) {
      const saved: State=JSON.parse(checkpoint);
      records.splice(0,records.length,...saved.records);state.policy=saved.policy;state.bindings=saved.bindings;
      throw Object.assign(Error('保存调度状态失败',{cause:error}),{code:'STATE_WRITE'});
    }
    checkpoint=next;
    onEvent(type,structuredClone(data));
  }
  const records: RecordState[]=state.records;
  const find=(id: string)=>records.find(r=>r.id===id);
  const bindingKey=(r: Target)=>r.agent+'|'+workspaceKey(r.cwd);
  async function update(r: RecordState,changes: Partial<RecordState>) {
    Object.assign(r,changes,{updatedAt:Date.now()});
    if(terminal.has(r.status))r.completedAt??=r.updatedAt;
    await commit('dispatch.updated',r);
  }
  async function add(body: DispatchRequest,parent?: RecordState | null,sourceJob?: string) {
    const from=ref(body.from),to=ref({...body.to,cwd:body.to?.cwd??from.cwd},true);
    requireValue(from.agent!==to.agent && workspaceKey(from.cwd)===workspaceKey(to.cwd),'只能委派给同项目的另一助手');
    requireValue(typeof body.prompt==='string' && body.prompt.trim() && Buffer.byteLength(body.prompt)<=16000,'委派消息须在 16 KB 内');
    requireValue(typeof body.objective==='string' && body.objective.trim() && body.objective.length<=512,'任务目标须在 512 字内');
    requireValue(body.autoReturn==null || typeof body.autoReturn==='boolean','无效回传选项');
    // Target replies and receipt replies share one budget, even when both request another turn.
    const hop=parent?records.reduce((last,r)=>r.chainId===parent.chainId?Math.max(last,r.hop):last,0)+1:1;
    const id=randomUUID();
    requireValue(hop<=state.policy.maxHops,'已达到最大调度跳数',409);
    if(parent)requireValue(!records.some(r=>r.chainId===parent.chainId && (r.cancelRequested||['failed','stopped','rejected'].includes(r.status))), '调度链已停止',409);
    const record: RecordState={id,chainId:parent?.chainId||id,parentDispatchId:parent?.id||null,sourceJob,hop,from,to,
      objective:body.objective.trim(),prompt:body.prompt,autoReturn:body.autoReturn!==false,
      status:state.policy.mode==='confirm'?'awaiting_confirm':'queued',createdAt:Date.now(),updatedAt:Date.now()};
    records.push(record);
    await commit('dispatch.updated',record);
    return record;
  }
  async function intercept(from: Target,job: RuntimeTurn,parent?: RecordState) {
    const command=directive(job.answer??job.text);
    if(!command || records.some(r=>r.sourceJob===job.id))return;
    try {
      requireValue(validSessionId(from.agent,from.sessionId),'无效的发起会话');
      await add({from:{...from,sessionId:from.sessionId},to:{agent:command.toAgent,sessionId:command.toSessionId,cwd:from.cwd,projectId:from.projectId},
        objective:command.objective,prompt:command.prompt,autoReturn:command.autoReturn},parent,job.id);
    } catch(error) {const e=runtimeError(error);
      if(!e.httpStatus)throw e;
      if(parent)await update(parent,{dispatchNotice:e.message});
    }
  }
  async function sessions(target: Target) {
    return (await adapters[target.agent].sessions(target)).filter(s=>validSessionId(target.agent,s.sessionId)
      && workspaceKey(s.cwd)===workspaceKey(target.cwd));
  }
  async function reserve(r: RecordState) {
    if(!r.sourceJob)requireValue((await sessions(r.from)).some(s=>s.sessionId===r.from.sessionId),
      '发起会话已删除、归档或不属于此项目',409);
    const available=await sessions(r.to),bound=state.bindings[bindingKey(r.to)];
    const selected=r.to.sessionId?available.find(s=>s.sessionId===r.to.sessionId):
      bound?available.find(s=>s.sessionId===bound.sessionId):available[0];
    requireValue(!r.to.sessionId||selected,'目标会话已删除、归档或不属于此项目',409);
    if(selected)r.to={...r.to,...selected};
    await update(r,{targetJobId:randomUUID()});
  }
  async function status(adapter: AgentRuntimeAdapter,id: string) {
    try {return await adapter.getTurnStatus(id)}
    catch(error) {const e=runtimeError(error);if(e.httpStatus!==404 && e.code!=='ENOENT')throw e;return null}
  }
  async function advance(r: RecordState) {
    const returning=!!r.returnJobId;
    const target=returning?r.from:r.to,adapter=adapters[target.agent];
    const id=returning?r.returnJobId:r.targetJobId;
    requireValue(id,'缺少调度任务 ID');
    const job=await status(adapter,id);
    if(r.cancelRequested) {
      if(!job || terminal.has(job.status)||stopped.has(job.status)||['error','disconnected'].includes(job.status))
        await update(r,{status:'stopped',approval:null});
      else if(!r.interruptSent){
        try {await adapter.cancelTurn(id,job);await update(r,{interruptSent:true})}
        catch(error){const e=runtimeError(error);if(e.httpStatus!==409)throw e}
      }
      return;
    }
    if(!job) {
      try {
        if(returning && !(await sessions(target)).some(s=>s.sessionId===target.sessionId))
          throw Error('发起会话已删除、归档或不属于此项目');
        await adapter.startTurn({...target,id,prompt:returning?'委派结果\n'+r.summary:r.prompt,queue:true});
      } catch(error) {const e=runtimeError(error);if(e.code==='SESSION_BUSY')return;throw e}
      return;
    }
    const sessionId=job.session||job.thread;
    if(!returning && sessionId) {
      const key=bindingKey(r.to);
      if(r.to.sessionId!==sessionId || state.bindings[key]?.sessionId!==sessionId) {
        r.to={...r.to,sessionId};state.bindings[key]={...r.to,sessionId};await update(r,{});
      }
    }
    if(job.status==='done') {
      await intercept(returning?r.from:r.to,job,r);
      if(!returning && r.autoReturn)await update(r,{status:'returning',approval:null,summary:receipt(r,job),returnJobId:randomUUID()});
      else await update(r,{status:'done',approval:null,summary:returning?r.summary:receipt(r,job)});
      return;
    }
    if(stopped.has(job.status)||['error','failed','disconnected'].includes(job.status)) {
      await update(r,{status:stopped.has(job.status)?'stopped':'failed',approval:null,summary:job.error||job.status});
      return;
    }
    const approval=job.approval?{...job.approval,agent:target.agent,jobId:id,canAnswer:job.approval.canAnswer!==false}:null;
    const next=approval?'waiting_approval':returning?'returning':job.status==='queued'?'queued':'running';
    const returnStarted=returning&&job.status!=='queued';
    if(r.status!==next || returnStarted!==!!r.returnStarted || JSON.stringify(approval)!==JSON.stringify(r.approval??null))
      await update(r,{status:next,approval,returnStarted});
  }
  async function tick() {
    for(const {id} of [...records]) {
      const r=find(id);if(!r)continue;
      if(terminal.has(r.status)||r.status==='awaiting_confirm')continue;
      try {
        if(!r.targetJobId) {
          if(r.hop>state.policy.maxHops)throw Error('已达到最大调度跳数');
          if(r.parentDispatchId && records.some(p=>p.chainId===r.chainId && ['failed','stopped','rejected'].includes(p.status))){
            await update(r,{status:'stopped',summary:'上级调度已停止'});continue;
          }
          const same=records.filter(other=>other!==r && other.targetJobId && !terminal.has(other.status)
            && workspaceKey(other.to.cwd)===workspaceKey(r.to.cwd));
          if(same.length && (state.policy.singleWriterLock||same.some(other=>other.to.agent===r.to.agent)))continue;
          await reserve(r);
        }
        await advance(r);
      } catch(error) {const e=runtimeError(error);
        if(e.code==='STATE_WRITE'||/OFFLINE|DISCONNECT|TRANSPORT|TIMEOUT|RATE_LIMIT/i.test([e.code,e.message].join(' '))||r.cancelRequested)continue;
        await update(r,{status:'failed',approval:null,summary:e.message});
      }
    }
  }
  function schedule() {
    if(closed||!interval||timer)return;
    timer=setTimeout(async()=>{
      try {await serialized(tick)}catch(error){const e=runtimeError(error);console.error('Orchestrator:',e.message)}
      timer=undefined;if(records.some(r=>!terminal.has(r.status)&&r.status!=='awaiting_confirm'))schedule();
    },interval);
    timer.unref();
  }
  schedule();
  return {
    list:({cwd,id}: {cwd?: string;id?: string}={})=>{
      const key=cwd&&workspaceKey(cwd);
      return structuredClone({records:records.filter(r=>(!id||r.id===id)&&(!key||workspaceKey(r.from.cwd)===key)),
        policy:state.policy,bindings:Object.values(state.bindings).filter(b=>!key||workspaceKey(b.cwd)===key)});
    },
    sessions:async (cwd: string)=>(await Promise.all((['codex','antigravity'] as const).map(agent=>sessions({agent,cwd})))).flat(),
    async dispatch(body: DispatchRequest,fromCli=false) {
      return serialized(async()=>{
        const parent=body.parentDispatchId?find(body.parentDispatchId):fromCli&&records.find(r=>{
          if(terminal.has(r.status)||!r.targetJobId)return false;
          const active=r.returnJobId?r.from:r.to;
          return active.agent===body.from?.agent && active.sessionId===body.from?.sessionId
            && workspaceKey(active.cwd)===workspaceKey(body.from.cwd);
        });
        requireValue(!body.parentDispatchId||parent,'找不到上级委派',404);
        if(parent)requireValue([parent.from,parent.to].some(s=>s.agent===body.from?.agent && s.sessionId===body.from?.sessionId
          && workspaceKey(s.cwd)===workspaceKey(body.from.cwd)),'发起会话与调度链不匹配');
        const record=await add(body,parent||null);schedule();return structuredClone(record);
      });
    },
    observe(agent: AgentKind,job: RuntimeTurn) {
      const cwd=job.cwd;
      if(job.status!=='done'||!cwd||!directive(job.answer??job.text))return Promise.resolve();
      return serialized(async()=>{
        if(records.some(r=>r.targetJobId===job.id||r.returnJobId===job.id))return;
        await intercept({agent,cwd,sessionId:job.thread||job.session,projectId:job.selection?.projectId},job);schedule();
      });
    },
    policy(patch: Partial<DispatchPolicy>={}) {return serialized(async()=>{
      const policy={...state.policy,...patch};
      requireValue(validPolicy(policy) && Object.keys(policy).every(k=>Object.hasOwn(defaults,k)),'无效调度策略');
      if(Object.keys(patch).length){state.policy=policy;await commit('policy.updated',policy)}
      return {...policy};
    })},
    approve({id,decision,token}: {id: string;decision: string;token?: string}) {return serialized(async()=>{
      const r=find(id);
      requireValue(r && ['approve','reject'].includes(decision),'无效委派或决定');
      if(r.status==='waiting_approval') {
        requireValue(!r.cancelRequested && token && token===r.approval?.token && r.approval.canAnswer,'审批已关闭或需要在会话中回答',409);
        await adapters[r.approval.agent].answerApproval(r.approval.jobId,token,decision==='approve'?'allow-once':'reject-once');
        await update(r,{status:r.returnJobId?'returning':'running',approval:null});
      } else {
        requireValue(r.status==='awaiting_confirm' && !token,'此委派已处理',409);
        await update(r,{status:decision==='approve'?'queued':'rejected'});
      }
      schedule();return structuredClone(r);
    })},
    cancel({id}: {id: string}) {return serialized(async()=>{
      const record=find(id);requireValue(record,'找不到委派',404);
      const chain=records.filter(r=>r.chainId===record.chainId&&!terminal.has(r.status));
      // Persist the whole chain's cancellation fence before attempting any interrupt.
      for(const r of chain){r.cancelRequested=true;if(!r.targetJobId){r.status='stopped';r.completedAt=Date.now()}}
      for(const r of chain)await update(r,{approval:null});
      schedule();return structuredClone(record);
    })},
    tick:()=>serialized(tick),
    close:async()=>{closed=true;clearTimeout(timer);await tail}
  };
}
