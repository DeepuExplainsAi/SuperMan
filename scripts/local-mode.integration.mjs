#!/usr/bin/env node
// Offline integration suite. Uses isolated temporary data, a loopback mock model, and real local services.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import WebSocket from 'ws';
const root = await mkdtemp(join(process.cwd(), '.data-local-test-'));
Object.assign(process.env, { OPENMAN_LOCAL_MODE: '1', OPENMAN_APP_DATA: root, OPENMAN_WORKSPACE: join(root, 'workspace'), OPENMAN_WS_PORT: '0', NODE_ENV: 'test' });
const mod = (path) => import(`../src/${path}.ts`);
let database, agent, host, modelServer, tickServer;
try {
  const { ensureBootstrap } = await mod('lib/local/bootstrap');
  const first = ensureBootstrap(); assert.match(first.secrets.APP_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  assert.equal(ensureBootstrap().secrets.SESSION_SECRET, first.secrets.SESSION_SECRET);
  const { initLocalDb } = await mod('lib/local/db-adapter');
  database = await initLocalDb();
  const migrations = await database.pgClient.query('select name from _om_migrations'); assert(migrations.rows.length > 0);
  const account = await database.from('accounts').upsert({ user_id: 'local-user', name: 'Laptop owner' }).select().single(); assert.equal(account.error, null); assert.equal(account.data.name, 'Laptop owner');
  assert.equal((await database.from('accounts').upsert({ user_id: 'local-user', name: 'Updated' }).select().single()).data.name, 'Updated');
  const { getSession } = await mod('lib/session/index'); assert.equal((await getSession()).userId, 'local-user');
  const settings = await mod('lib/db/settings'); await settings.patchSettings('local-user', { nested: { enabled: true } }); assert.equal((await settings.getSettings('local-user')).nested.enabled, true);
  assert.equal((await database.rpc('api_rate_hit', { p_bucket: 'integration', p_window: new Date().toISOString() })).error, null);
  console.log('PASS database migrations, query adapter, encrypted bootstrap, auto-session');
  const fs = await mod('lib/local/host-fs'); const dest = join(root, 'workspace', 'hello.txt'); await fs.writeLocalFile(dest, 'local file'); assert.equal((await fs.readLocalFile(dest)).toString(), 'local file');
  const { LocalHostClient } = await mod('lib/local/host-client'); const client = new LocalHostClient();
  const { transfer } = await mod('lib/agent/server/uploads'); await transfer(client, 'local-host', join(root, 'workspace'), 'upload.txt', Buffer.from('uploaded')); assert.equal(await readFile(join(root, 'workspace', 'upload.txt'), 'utf8'), 'uploaded');
  assert.match((await client.bash('local-host', 'echo local-shell')).output, /local-shell/);
  console.log('PASS local shell, filesystem and upload transfer');
  const jobs = await mod('lib/local/jobs');
  const jobDir = join(root, 'voice-job');
  await jobs.launchPythonJob(jobDir, jobs.pythonJob("from pathlib import Path\nPath('out.json').write_text('{\"text\":\"native job completed\"}')"));
  let job;
  for (let i=0; i<100; i++) { job = await jobs.pythonJobState(jobDir); if (job.state !== 'running') break; await new Promise(r=>setTimeout(r,20)); }
  assert.equal(job.state, 'done'); assert.equal(JSON.parse(job.output).text, 'native job completed');
  const { whisperJobScript } = await mod('lib/voice/whisper');
  const { nativeScribeJob } = await mod('lib/voice/native-scribe');
  const { runPython } = await mod('lib/local/process');
  const { HELPER_PY } = await mod('lib/generators/helper-program');
  const generatorHelper=join(root,'.openman','bin','om_gen.py');await fs.writeLocalFile(generatorHelper,HELPER_PY);
  const generatorProbe=JSON.parse(await runPython([generatorHelper,'probe']));assert.equal(generatorProbe.python3,true);
  assert(!HELPER_PY.includes('curl -LsSf'));assert(!HELPER_PY.includes('shell=True'));
  const generatorFolder=join(root,'workspace',"generator user's output");
  await fs.writeLocalFile(join(generatorFolder,'.openman','generator.json'),JSON.stringify({version:1,kind:'slides'}));
  await fs.writeLocalFile(join(generatorFolder,'slides','deck.json'),JSON.stringify({version:1,title:'Local deck',slides:[{file:'01.html',title:'Offline slide',notes:'Speaker notes'}]}));
  await fs.writeLocalFile(join(generatorFolder,'slides','01.html'),'<html><head><link rel="stylesheet" href="theme.css"></head><body><h1>Offline slide</h1></body></html>');
  await fs.writeLocalFile(join(generatorFolder,'slides','theme.css'),'body { color: red; }');
  const generatorState=JSON.parse(await runPython([generatorHelper,'state',generatorFolder]));assert.equal(generatorState.deck.title,'Local deck');
  const deckPath=join(root,'deck.json.gz');assert.equal(JSON.parse(await runPython([generatorHelper,'deck',generatorFolder,deckPath])).ok,true);
  const bundle=JSON.parse(gunzipSync(await readFile(deckPath)).toString('utf8'));assert.match(bundle.html[0],/Offline slide/);assert.match(bundle.html[0],/color: red/);
  const htmlExport=JSON.parse(await runPython([generatorHelper,'export',generatorFolder,'html']));assert.equal(htmlExport.ok,true);assert.match(await readFile(join(generatorFolder,htmlExport.path),'utf8'),/Speaker notes/);
  const {contractFor}=await mod('lib/generators/contracts');
  const contractContext={folder:generatorFolder,helper:generatorHelper,python:process.execPath,inputs:[],localShell:'posix'};
  const slideContract=contractFor('slides',undefined,contractContext);
  assert(!slideContract.includes('todo_list'));assert(!slideContract.includes('vision_analyze'));assert(slideContract.includes('web_fetch'));
  const thumbnailCommand=slideContract.match(/Visual check: run `([^`]+)`/)[1];
  const contractThumb=await client.bash('local-host',thumbnailCommand.replace("'thumbs'","'state'"));
  assert.equal(JSON.parse(contractThumb.output).deck.title,'Local deck','Quoted task paths survive spaces and apostrophes');
  const winContract=contractFor('audio',undefined,{...contractContext,localShell:'powershell',python:"C:\\Users\\Owner's Files\\python.exe"});
  assert(winContract.includes("& 'C:\\Users\\Owner''s Files\\python.exe' -m edge_tts"));assert(!winContract.includes('`edge-tts --'));
  const researchContract=contractFor('research',undefined,contractContext);assert(researchContract.includes('research items yourself'));assert(!researchContract.includes('with delegate_task'));
  assert(contractFor('image',undefined,contractContext).includes('No built-in image_generate tool'));
  assert(contractFor('video',undefined,contractContext).includes('No built-in video_generate tool'));
  const mediaContract=contractFor('image',undefined,{...contractContext,mediaTools:[{kind:'image',server:'test-media',tool:'image_generate'}]});assert(mediaContract.includes('test-media'));assert(mediaContract.includes('inspect the actual input schema'));assert(!mediaContract.includes('No built-in'));
  console.log('PASS native generator probing, slide state, bundles, offline HTML export, shell path quoting and honest native tool contracts');
  for (const descriptor of [whisperJobScript('audio.wav', {prompt: 'Names'}), nativeScribeJob('audio.wav', 'fake-token', 'scribe_v2', {keyterms: []})]) {
    const {source} = JSON.parse(descriptor.split('\n').slice(1).join('\n'));
    await fs.writeLocalFile(join(root,'syntax.py'), source);
    await runPython(['-m','py_compile',join(root,'syntax.py')]);
  }
  console.log('PASS detached native job lifecycle and transcription program syntax');
  const { mcpRequest } = await mod('lib/local/mcp');
  const { seal } = await mod('lib/crypto');
  const mcpProgram = `const readline=require('node:readline');let initialized=false;readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.method==='notifications/initialized'){initialized=true;return;} const result=q.method==='initialize'?{protocolVersion:'2025-03-26'}:{tools:initialized&&process.env.MCP_TEST==='staged-secret'?[{name:'echo'}]:[]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`;
  const mcpTools = await mcpRequest({transport:'command',command:process.execPath,args:['-e',mcpProgram],secretEnc:seal(JSON.stringify({MCP_TEST:'staged-secret'}))},'tools/list');
  assert.equal(mcpTools.tools[0].name,'echo');
  await assert.rejects(mcpRequest({transport:'command',command:process.execPath,args:['-e','process.exit(0)']},'tools/list'), /exited before responding/);
  let initialized=false, terminated=false;
  const mcpHttp=createServer(async(req,res)=>{
    if(req.method==='DELETE'){terminated=true;res.writeHead(204);res.end();return;}
    let text='';for await(const chunk of req)text+=chunk;const q=JSON.parse(text);
    if(q.method==='initialize'){res.setHeader('Mcp-Session-Id','test-session');res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26'}}));return;}
    assert.equal(req.headers['mcp-session-id'],'test-session');
    if(q.method==='notifications/initialized'){initialized=true;res.writeHead(202);res.end();return;}
    assert(initialized);res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'http-echo'}]}})+'\n\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress'})+'\n\n');
  });
  await new Promise(r=>mcpHttp.listen(0,'127.0.0.1',r));
  try { assert.equal((await mcpRequest({transport:'http',url:`http://127.0.0.1:${mcpHttp.address().port}`},'tools/list')).tools[0].name,'http-echo'); assert(terminated); }
  finally {mcpHttp.closeAllConnections();await new Promise(r=>mcpHttp.close(r));}
  console.log('PASS MCP stdio lifecycle, secret environment, HTTP sessions and SSE response selection');
  const supervisor = await mod('lib/local/site-supervisor');
  const siteFolder = join(root, 'workspace', 'sites', 'integration');
  await fs.writeLocalFile(join(siteFolder, 'index.html'), '<h1>local site</h1>');
  await fs.writeLocalFile(join(siteFolder, '.env'), 'SECRET=must-not-serve');
  await symlink(join(siteFolder, '.env'), join(siteFolder, 'public-env')).catch(() => {});
  const siteUrl = await supervisor.startSiteService({ id: 'integration-site', folder: siteFolder, root: siteFolder, port: 4199, persistent: true });
  try {
    assert.match(await (await fetch(siteUrl)).text(), /local site/);
    assert.equal((await fetch(siteUrl + '/.env')).status, 404);
    assert.equal((await fetch(siteUrl + '/public-env')).status, 404);
  } finally { await supervisor.stopSiteService('integration-site'); }
  const siteScript=join(siteFolder,'server.cjs');
  await fs.writeLocalFile(siteScript, "require('node:http').createServer((req,res)=>res.end('supervised process')).listen(Number(process.env.PORT),'127.0.0.1');");
  const processUrl=await supervisor.startSiteService({id:'process-site',folder:siteFolder,root:siteFolder,port:4198,persistent:true,command:`"${process.execPath}" "${siteScript}"`});
  assert.equal(await(await fetch(processUrl)).text(),'supervised process');
  await supervisor.stopSiteService('process-site');
  const {createServer: httpServer}=await import('node:http');
  const occupied=httpServer();await new Promise(r=>occupied.listen(4197,'127.0.0.1',r));
  try {await assert.rejects(supervisor.startSiteService({id:'occupied',folder:siteFolder,root:siteFolder,port:4197,persistent:true}), /EADDRINUSE/);}
  finally {await new Promise(r=>occupied.close(r));}
  console.log('PASS loopback website serving, process readiness/stop, hidden-file and symlink protection');
  const {KIT_FILES}=await mod('lib/websites/kit-files');
  const kit=join(root,'site-kit');
  for(const [name,content] of Object.entries(KIT_FILES)) await fs.writeLocalFile(join(kit,name),content);
  const staticUrl=await supervisor.startSiteService({id:'static-kit',folder:siteFolder,root:siteFolder,port:4196,persistent:false,program:process.execPath,args:[join(kit,'static-serve.mjs')]});
  try {
    assert.match(await(await fetch(staticUrl)).text(),/__om\/inspector/);
    assert.equal((await fetch(staticUrl+'/public-env')).status,404);
  } finally {await supervisor.stopSiteService('static-kit');}
  const release=join(siteFolder,'.openman','release');
  for(const [name,content] of Object.entries(KIT_FILES)) if(name.startsWith('fullstack/')) await fs.writeLocalFile(join(release,name.slice(10)),content);
  const fullstackUrl=await supervisor.startSiteService({id:'fullstack-kit',folder:siteFolder,root:release,port:4399,persistent:true,program:process.execPath,args:[join(release,'server.mjs')]});
  try {
    const signup=await fetch(fullstackUrl+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'local@example.com',password:'test-password-123'})});
    assert(signup.ok,await signup.text());
    const cookie=signup.headers.get('set-cookie')?.split(';')[0];assert(cookie);
    const add=await fetch(fullstackUrl+'/api/notes',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({body:'persist on the source site'})});assert(add.ok,await add.text());
    const notes=await(await fetch(fullstackUrl+'/api/notes',{headers:{Cookie:cookie}})).json();assert.equal(notes.notes[0].body,'persist on the source site');
    const {runPython}=await mod('lib/local/process');
    const tables=JSON.parse((await runPython([join(kit,'dbtool.py'),siteFolder,Buffer.from(JSON.stringify({op:'tables'})).toString('base64')])).trim());
    assert(!tables.error,JSON.stringify(tables));
    await fetch(fullstackUrl+'/');
    assert((await readFile(join(siteFolder,'.openman','data','app.db'))).length>0);
  } finally {await supervisor.stopSiteService('fullstack-kit');}
  console.log('PASS native static inspector and published full-stack sign-in, notes, source-site SQLite and database helper');
  const {archiveSite,siteGit,commitSite}=await mod('lib/local/site-files');
  const archive=await archiveSite(siteFolder);const archivePath=join(root,archive.name);await fs.writeLocalFile(archivePath,archive.bytes);
  const archiveNames=JSON.parse(await runPython(['-c',"import json,sys,tarfile;print(json.dumps(tarfile.open(sys.argv[1]).getnames()))",archivePath]));
  assert(archiveNames.some(name=>name.endsWith('index.html')));assert(!archiveNames.some(name=>name.includes('.env')||name.includes('.openman')||name.includes('public-env')));
  await fs.writeLocalFile(join(siteFolder,'.gitignore'),'.env\n.openman/\n');
  await siteGit(siteFolder,['init','-q']);await siteGit(siteFolder,['config','user.name','Local test']);await siteGit(siteFolder,['config','user.email','local@example.com']);
  assert.match(await commitSite(siteFolder,'Native checkpoint'),/^[a-f0-9]{40}$/);
  console.log('PASS native website checkpoints and source archives exclude secrets, private data and symlinks');
  modelServer = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    for(const tool of body.tools || []) {const schema=tool.function?.parameters||tool.input_schema;assert.equal(schema.type,'object');for(const field of Object.values(schema.properties||{})) if(field.type==='array') assert(field.items,'Provider array schemas require items');}
    if(req.url.endsWith('/messages')) {
      assert.equal(req.headers['x-api-key'],'anthropic-test-key');assert.equal(body.model,'mapped-model');assert.match(body.system,/Provider test instructions/);
      assert(body.messages.every(item=>item.role!=='system'));
      const done=body.messages.some(item=>Array.isArray(item.content)&&item.content.some(block=>block.type==='tool_result'));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:done?[{type:'text',text:'Anthropic-compatible loop completed.'}]:[{type:'tool_use',id:'anthropic-write',name:'file_write',input:{path:'anthropic-result.txt',content:'Anthropic adapter'}}]}));return;
    }
    if (req.headers.authorization?.startsWith('Bearer protocol-')) {assert.equal(body.model,'mapped-model');assert(body.messages.some(item=>item.role==='system'&&item.content.includes('Provider test instructions')));}
    const message = body.messages.some(m => m.role === 'tool') ? { content: 'Local task completed.' } : { content: '', tool_calls: [{ id: 'test-write', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ path: 'agent-result.txt', content: 'written by agent' }) } }] };
    if (body.messages.some(m=>m.role==='user'&&m.content==='approval-test') && !body.messages.some(m=>m.role==='tool')) message.tool_calls=[{id:'approved-command',type:'function',function:{name:'shell',arguments:JSON.stringify({command:'echo APPROVED_LOCAL_TEST'})}}];
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(r => modelServer.listen(0, '127.0.0.1', r));
  const config = { provider: 'ollama', model: 'integration', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, apiKey: 'test-secret-not-plaintext' };
  const { writeLocalModelConfig } = await mod('lib/db/local-models'); await writeLocalModelConfig(config);
  assert(!(JSON.stringify(await settings.getSettings('local-user'))).includes(config.apiKey));
  const runtime = await mod('lib/local/agent-server/index'); agent = await runtime.startAgentServer({ port: 0 });
  const { localServiceToken } = await mod('lib/local/auth');
  const base = `http://127.0.0.1:${agent.address().port}`; const headers = { Authorization: `Bearer ${localServiceToken()}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/runs`, { method: 'POST', body: '{}' })).status, 403);
  const started = await fetch(`${base}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ input: 'write a local file', session_id: 'integration-session' }) }); assert.equal(started.status, 202);
  const { run_id } = await started.json();
  const events = await (await fetch(`${base}/v1/runs/${run_id}/events`, { headers, signal: AbortSignal.timeout(10000) })).text(); assert.match(events, /tool.completed/); assert.match(events, /run.completed/);
  assert.equal(await readFile(join(root, 'workspace', 'agent-result.txt'), 'utf8'), 'written by agent');
  const replay = await (await fetch(`${base}/v1/runs/${run_id}/events`, { headers: { ...headers, 'Last-Event-ID': '2' } })).text(); assert(!replay.includes('id: 1\n')); assert(!replay.includes('id: 2\n'));
  const history = await (await fetch(`${base}/api/sessions/integration-session/messages?limit=20&order=latest`, {headers})).json();
  assert(history.data.some(item=>item.role==='assistant'&&item.tool_calls?.[0]?.function?.name==='file_write'));
  assert(history.data.some(item=>item.role==='tool'&&item.tool_call_id==='test-write'));
  const controller = new AbortController();
  const pending = client.bash('local-host', process.platform==='win32'?'Start-Sleep -Seconds 30':'sleep 30', 60, controller.signal);
  setTimeout(()=>controller.abort(),50);
  assert.match((await pending).error,/cancelled/);
  console.log('PASS agent authentication, tool identifiers/transcripts, shell cancellation, SSE reconnect');
  await fs.writeLocalFile(join(root,'workspace','agent-result.txt'),'read-only sentinel');
  const readonly=await(await fetch(`${base}/p/om-chat/v1/runs`,{method:'POST',headers,body:JSON.stringify({input:'read-only test',session_id:'readonly-session'})})).json();
  const readonlyEvents=await(await fetch(`${base}/v1/runs/${readonly.run_id}/events`,{headers})).text();
  assert.match(readonlyEvents,/read-only/);assert.equal(await readFile(join(root,'workspace','agent-result.txt'),'utf8'),'read-only sentinel');
  const approveInput={input:'approval-test',session_id:'approval-session'};
  const approveHeaders={...headers,'Idempotency-Key':'integration-idempotency'};
  const approved=await(await fetch(`${base}/v1/runs`,{method:'POST',headers:approveHeaders,body:JSON.stringify(approveInput)})).json();
  const duplicate=await(await fetch(`${base}/v1/runs`,{method:'POST',headers:approveHeaders,body:JSON.stringify(approveInput)})).json();assert.equal(approved.run_id,duplicate.run_id);
  let waiting;
  for(let i=0;i<100;i++){waiting=await(await fetch(`${base}/v1/runs/${approved.run_id}`,{headers})).json();if(waiting.pending_controls.length)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting.pending_controls[0].type,'approval');
  const control={request_id:waiting.pending_controls[0].id,execution_generation:waiting.execution_generation,choice:'once'};
  assert.equal((await fetch(`${base}/v1/runs/${approved.run_id}/approval`,{method:'POST',headers,body:JSON.stringify({...control,execution_generation:-1})})).status,409);
  assert.equal((await fetch(`${base}/v1/runs/${approved.run_id}/approval`,{method:'POST',headers,body:JSON.stringify(control)})).status,200);
  const approvedEvents=await(await fetch(`${base}/v1/runs/${approved.run_id}/events`,{headers})).text();assert.match(approvedEvents,/APPROVED_LOCAL_TEST/);assert.match(approvedEvents,/run.completed/);
  console.log('PASS read-only action rejection, run idempotency, approval execution and stale-control rejection');
  const interrupted=await(await fetch(`${base}/v1/runs`,{method:'POST',headers,body:JSON.stringify({input:'approval-test',session_id:'interrupted-session'})})).json();
  for(let i=0;i<100;i++){const status=await(await fetch(`${base}/v1/runs/${interrupted.run_id}`,{headers})).json();if(status.pending_controls.length)break;await new Promise(r=>setTimeout(r,20));}
  await fetch(`${base}/v1/runs/${interrupted.run_id}/stop`,{method:'POST',headers,body:'{}'});
  const resumed=await(await fetch(`${base}/v1/runs`,{method:'POST',headers,body:JSON.stringify({input:'Continue after the stopped tool',session_id:'interrupted-session'})})).json();
  assert.match(await(await fetch(`${base}/v1/runs/${resumed.run_id}/events`,{headers})).text(),/run.completed/);
  const recovered=await(await fetch(`${base}/api/sessions/interrupted-session/messages`,{headers})).json();assert(recovered.data.some(item=>item.role==='tool'&&item.content.includes('outcome is unknown')));
  for(const provider of ['anthropic','openai','gemini','openrouter','lmstudio']) {
    await writeLocalModelConfig({...config,provider,apiKey:provider==='anthropic'?'anthropic-test-key':`protocol-${provider}`,modeModels:{max:'mapped-model'}});
    const start=await(await fetch(`${base}/v1/runs`,{method:'POST',headers,body:JSON.stringify({input:'Run a provider protocol test',session_id:`provider-${provider}`,model:'mapped-model',instructions:'Provider test instructions'})})).json();
    const stream=await(await fetch(`${base}/v1/runs/${start.run_id}/events`,{headers})).text();assert.match(stream,/run.completed/,`${provider}: ${stream}`);assert.match(stream,/tool.completed/);
  }
  assert.equal(await readFile(join(root,'workspace','anthropic-result.txt'),'utf8'),'Anthropic adapter');
  await writeLocalModelConfig(config);
  console.log('PASS interrupted-tool transcript recovery and five provider protocol adapters with per-mode model selection');
  const services = await mod('lib/local/services'); host = await services.startHostServices();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.address().port}/ws/terminal?token=${services.desktopToken()}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Terminal timed out')); }, 10000);
    let output = '';
    ws.on('open', () => ws.send(JSON.stringify({ type: 'input', data: 'echo TERMINAL_INTEGRATION_OK\n' })));
    ws.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'output') output += frame.data; if (output.includes('TERMINAL_INTEGRATION_OK')) { clearTimeout(timer); ws.close(); resolve(); } });
    ws.on('error', reject);
  });
  console.log('PASS authenticated local terminal session');
  process.env.OPENMAN_AGENT_PORT=String(agent.address().port);
  const {createAutomation}=await mod('lib/automations/service');
  const {localSession}=await mod('lib/session/local');
  const {automationInputSchema}=await mod('lib/automations/types');
  const automation=await createAutomation(localSession(),automationInputSchema.parse({name:'Local integration clock',kind:'schedule',prompt:'write a scheduled result',repeat:{freq:'interval',everyMinutes:1},timezone:'UTC'}));
  const due=await database.from('automations').update({next_run_at:new Date(Date.now()-1000).toISOString()}).eq('user_id','local-user').eq('id',automation.id);assert.equal(due.error,null);
  const {tick}=await mod('lib/automations/engine');
  let tickResult;
  tickServer = createServer(async (req, res) => { assert.equal(req.url, '/api/cron/tick'); assert.equal(req.headers.authorization, `Bearer ${process.env.CRON_SECRET}`); tickResult=await tick();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(tickResult)); });
  await new Promise(r => tickServer.listen(0, '127.0.0.1', r)); process.env.PORT = String(tickServer.address().port);
  const { schedulerTick, startScheduler, stopScheduler } = await mod('lib/local/scheduler'); assert.equal(await schedulerTick(), true); startScheduler(); stopScheduler();
  assert.equal(tickResult.errors.length,0,JSON.stringify(tickResult));assert.equal(tickResult.fired.length,1,JSON.stringify(tickResult));
  const scheduledTasks=await database.from('tasks').select('id').eq('user_id','local-user');assert(scheduledTasks.data.length>0);
  for (const task of scheduledTasks.data) {
    let finished;
    for (let i=0;i<150;i++) {const state=await database.from('tasks').select('status').eq('id',task.id).single();finished=state.data?.status;if(['completed','error','stopped'].includes(finished)) break;await new Promise(r=>setTimeout(r,100));}
    const {forgetRuntime}=await mod('lib/agent/server/relay');forgetRuntime(task.id);
    assert.equal(finished,'completed','Scheduled task must complete before services stop');
  }
  console.log('PASS authenticated scheduler tick executes a due persisted automation through the real task engine');
  console.log('Local mode integration tests passed.');
} finally {
  for (const server of [agent, host, modelServer, tickServer]) if (server) { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
  if (database) await database.pgClient.close();
  await rm(root, { recursive: true, force: true });
}
