import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';

const usage=`node orchestrator-cli.mjs <list|status|dispatch> --scope <device scope>
  list --cwd <host project path>
  status <dispatch ID>
  dispatch --cwd <host project path> --from-agent <codex|antigravity> --from-session <ID>
           --objective <goal> [--prompt <text>] [--to-session <ID>] [--parent <dispatch ID>] [--no-return]
CODEX_RECEIVER_SCOPE and CODEX_WEB_PORT can supply the scope and receiver port.
The scope is the 64-character ID in the workbench URL. Use --prompt - to read stdin.`;

async function main() {
  const {positionals:[command,id,...extra],values}=parseArgs({allowPositionals:true,options:{
    scope:{type:'string'},cwd:{type:'string'},'from-agent':{type:'string'},'from-session':{type:'string'},
    objective:{type:'string'},prompt:{type:'string'},'to-session':{type:'string'},parent:{type:'string'},
    'no-return':{type:'boolean'},help:{type:'boolean',short:'h'}
  }});
  if(values.help){console.log(usage);return}
  const scope=values.scope||process.env.CODEX_RECEIVER_SCOPE;
  if(!scope||!/^[0-9a-f]{64}$/.test(scope)||extra.length||!['list','status','dispatch'].includes(command)
    ||(command==='status'?!id:!!id))throw Error(usage);
  const port=Number(process.env.CODEX_WEB_PORT||47831);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid receiver port');
  const token=(await readFile(new URL('./state/orchestrator.token',import.meta.url),'utf8')).trim();
  async function call(action: string,body: object) {
    const res=await fetch('http://127.0.0.1:'+port+'/devices/'+scope+'/api/orchestrator/'+action,{
      method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(60000)
    });
    const data=await res.json();if(!res.ok)throw Error(data.error||'Receiver HTTP '+res.status);
    return data;
  }
  const cwd=values.cwd;
  let result;
  if(command==='status'){
    result=(await call('list',{id})).records[0];
    if(!result)throw Error('Dispatch not found');
  }else if(!cwd)throw Error('Specify the project path on the host with --cwd');
  else if(command==='list')result=await call('list',{cwd});
  else {
    const agent=values['from-agent'],sessionId=values['from-session'],objective=values.objective;
    if(!agent||!['codex','antigravity'].includes(agent)||!sessionId||!objective)throw Error(usage);
    let prompt=values.prompt||objective;
    if(prompt==='-'){
      const chunks=[];let bytes=0;
      for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>16000)throw Error('Prompt exceeds 16 KB');chunks.push(chunk)}
      prompt=Buffer.concat(chunks).toString('utf8');
    }
    result=await call('dispatch',{from:{agent,sessionId,cwd},to:{agent:agent==='codex'?'antigravity':'codex',
      sessionId:values['to-session'],cwd},objective,prompt,autoReturn:!values['no-return'],parentDispatchId:values.parent});
  }
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
