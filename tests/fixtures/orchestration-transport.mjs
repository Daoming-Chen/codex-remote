export const device='orchestration-fixture',threadId='10000000-0000-4000-8000-000000000001';
export const bindReceiverDevice=()=>{},requireReceiverIdentity=async()=>{};
export const listReceiverDevices=async()=>[{deviceId:device,name:'Fixture',online:true}];
const turns=[{id:'10000000-0000-4000-8000-000000000002',status:'completed',items:[
  {type:'agentMessage',text:'检查构建结果'}
]}];
const thread=()=>({id:threadId,name:'构建',cwd:'/project',projectId:'project',turns});
const created=new Map();
async function nativeCall(method,params){
  switch(method){
    case 'project/list':return {data:[{id:'project',name:'project',roots:['/project']}]};
    case 'thread/list':return {data:[thread(),...created.values()]};
    case 'thread/start':{
      const worker={id:crypto.randomUUID(),cwd:params.cwd,name:'new worker',turns:[]};created.set(worker.id,worker);return {thread:worker}
    }
    case 'thread/read':case 'thread/resume':return {thread:created.get(params.threadId)||thread()};
    case 'thread/goal/get':return {goal:null};
    case 'model/list':return {data:[{model:'fixture',displayName:'Fixture',isDefault:true}]};
    case 'turn/start':{
      const input=params.input[0].text;
      const turn={id:crypto.randomUUID(),status:'completed',items:[
        {type:'userMessage',content:[{type:'text',text:input}]},{type:'agentMessage',text:'已收到测试回执'}
      ]};(created.get(params.threadId)?.turns||turns).push(turn);return {turn}
    }
    default:throw Error(method);
  }
}
let listener,running=false;
const events=[];
function update(sessionUpdate,extra={}){
  listener({frame:{method:'session/update',params:{update:{sessionUpdate,...extra}}}});
}
const antigravity={
  sessionModes:async()=>({currentModeId:'ask',availableModes:[{id:'ask'}]}),
  call:async(method,params)=>method==='dsh/sessionList'?{items:params.path==='/agy-only'?[{conversationId:'agy-only-source',cwd:params.path}]:[{conversationId:'worker',title:'AGY worker',cwd:'/project',running}]}:
    method==='dsh/workspaceList'?[{path:'/project'}]:{},
  loadSessionDetails:async()=>({running,events}),
  openStream:async(id,cb)=>{listener=cb;return {close:async()=>{}}},
  prompt:async(id,prompt)=>{
    running=true;events.push({event:{type:'user/message',data:{content:[{type:'text',text:prompt}]}}});
    update('agent_message_chunk',{content:{text:'正在检查构建'}});
    listener({frame:{method:'session/request_permission',params:{requestHandle:'review',toolName:'检查文件',reason:'查看构建日志'}}});
    return {stopReason:'in_progress'}
  },
  respond:async(handle,decision)=>{
    if(handle!=='review'||decision!=='allow-once')throw Error('unexpected approval');
    running=false;events.push({event:{type:'assistant/message',data:{content:[{type:'text',text:'构建通过'}]}}});
    update('agent_message_chunk',{content:{text:'构建通过'}});update('prompt_completed')
  },
  cancel:async()=>{running=false;update('prompt_completed',{stopReason:'cancelled'})}
};
export async function openRemote(){return {nativeCall,nativeStream:{subscribe:async()=>({close:async()=>{}})},
  probe:async()=>({capabilities:['agent.acp.antigravity.v1']}),antigravity}}
