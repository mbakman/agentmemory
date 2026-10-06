import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function engineConfig(root, ports, http = false) {
  const workers = [
    {name:'iii-worker-manager',config:{host:'127.0.0.1',port:ports.ws}},
    {name:'iii-state',config:{adapter:{name:'kv',config:{store_method:'file_based',file_path:join(root,'data','state_store.db')}}}},
    {name:'iii-stream',config:{host:'127.0.0.1',port:ports.stream,adapter:{name:'kv',config:{store_method:'file_based',file_path:join(root,'data','stream_store')}}}},
  ];
  if (http) workers.push(
    {name:'iii-http',config:{host:'127.0.0.1',port:ports.rest,default_timeout:600000}},
    {name:'iii-queue',config:{adapter:{name:'builtin'}}},
    {name:'iii-pubsub',config:{adapter:{name:'local'}}},
    {name:'iii-cron',config:{adapter:{name:'kv'}}},
  );
  return JSON.stringify({workers},null,2)+'\n';
}

export function runtimeEnv(root, ports, embedding='none') {
  return {
    HOME:join(root,'home'),TMPDIR:join(root,'tmp'),PATH:join(root,'bin')+':/usr/bin:/bin',CI:'1',
    XDG_CONFIG_HOME:join(root,'home','.config'),XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'home','.local','share'),
    AGENTMEMORY_DATA_DIR:join(root,'data'),AGENTMEMORY_RUNTIME_DIR:join(root,'runtime'),
    AGENTMEMORY_III_CONFIG:join(root,'config','worker.yaml'),AGENTMEMORY_URL:`http://127.0.0.1:${ports.rest}`,
    III_ENGINE_URL:`ws://127.0.0.1:${ports.ws}`,III_ENGINE_PORT:String(ports.ws),III_REST_PORT:String(ports.rest),
    III_STREAM_PORT:String(ports.stream),III_STREAMS_PORT:String(ports.stream),III_VIEWER_PORT:String(ports.viewer),
    III_TELEMETRY_ENABLED:'false',OTEL_ENABLED:'false',AGENTMEMORY_ALLOW_AGENT_SDK:'false',AGENTMEMORY_AUTO_COMPRESS:'false',
    AGENTMEMORY_INJECT_CONTEXT:'false',AGENTMEMORY_IMAGE_EMBEDDINGS:'false',EMBEDDING_PROVIDER:embedding,
    GRAPH_EXTRACTION_ENABLED:'false',CONSOLIDATION_ENABLED:'false',AGENTMEMORY_SLOTS:'false',AGENTMEMORY_REFLECT:'false',
    AUTO_FORGET_ENABLED:'false',LESSON_DECAY_ENABLED:'false',INSIGHT_DECAY_ENABLED:'false',SNAPSHOT_ENABLED:'false',
    CLAUDE_MEMORY_BRIDGE:'false',AGENTMEMORY_STATE_BACKEND:'file',AGENTMEMORY_CAPTURE_SPOOL:'false',
    AGENTMEMORY_CAPTURE_SPOOL_DIR:join(root,'spool'),AGENTMEMORY_SESSION_SWEEP_ENABLED:'false',
    AGENTMEMORY_GRAPH_COMPACT_ON_BOOT:'false',AGENTMEMORY_AUDIT_RETENTION_MONTHS:'0',
  };
}

export function sandboxProfile(root, ports, protectedPaths) {
  const q=x=>JSON.stringify(x);
  return `(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow signal)\n(allow file-read*)\n${protectedPaths.map(p=>`(deny file-read* (subpath ${q(p)}))`).join('\n')}\n(allow file-write* (subpath ${q(root)}))\n(allow file-write* (literal "/dev/null"))\n${Object.values(ports).map(p=>`(allow network-bind (local ip "localhost:${p}"))\n(allow network-inbound (local ip "localhost:${p}"))\n(allow network-outbound (remote ip "localhost:${p}"))`).join('\n')}\n`;
}

export async function prepare(root, ports) {
  root=resolve(root);
  for (const dir of ['home/.agentmemory','home/.config','home/.local/share','data','runtime','config','run','tmp','spool','cache','logs','pkg','bin'])
    await mkdir(join(root,dir),{recursive:true,mode:0o700});
  root=await realpath(root);
  const files={
    'config/engine-only.yaml':engineConfig(root,ports),
    'config/worker.yaml':engineConfig(root,ports,true),
    'config/environment.json':JSON.stringify(runtimeEnv(root,ports),null,2)+'\n',
    'config/runtime.sb':sandboxProfile(root,ports,['/Users/bakman/.agentmemory','/Users/bakman/data','/opt/homebrew/lib/node_modules/@agentmemory/agentmemory','/Users/bakman/.iii']),
  };
  for(const [name,content] of Object.entries(files)) await writeFile(join(root,name),content,{mode:0o600,flag:'wx'});
  return {root,ports};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [root,base,ws]=process.argv.slice(2);
  if(!root||!/^\d+$/.test(base)||!/^\d+$/.test(ws)) throw new Error('Usage: node lab.mjs ROOT REST_BASE WS_PORT');
  console.log(JSON.stringify(await prepare(root,{rest:+base,stream:+base+1,viewer:+base+2,ws:+ws})));
}
