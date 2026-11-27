#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest, createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = await mkdtemp(join(process.cwd(), '.data-production-test-'));
const port = Number(process.env.OPENMAN_TEST_PORT || 3087);
const base = `http://127.0.0.1:${port}`;
const defaultMode = process.env.OPENMAN_SMOKE_DEFAULT === "1";
let log = '', backend, model;
try {
  model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-03-26'}:{tools:[{name:'smoke-mcp',description:'production loopback MCP'},{name:'image_generate',description:'test generation capability; not a real image model'}]}}));return;
    }
    const message = body.messages.some((item) => item.role === 'tool') ? { content: 'Production local task completed.' } : { content: '', tool_calls: [{ id: 'smoke-write', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ path: 'production-result.txt', content: 'production agent result' }) } }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  backend = spawn(process.execPath, ['--require', fileURLToPath(new URL('./offline-network-guard.cjs', import.meta.url)), '.next/standalone/server.js'], { cwd: process.cwd(), env: {
    ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), OPENMAN_LOCAL_MODE: defaultMode ? '' : '1', NEXT_PUBLIC_SUPABASE_URL: defaultMode ? '' : 'https://force-local-test.supabase.co',
    OPENMAN_DESKTOP_INSTANCE_TOKEN: 'test-desktop-instance-token', OPENMAN_APP_DATA: root, OPENMAN_WORKSPACE: join(root, 'workspace'), OPENMAN_AGENT_PORT: '18642', OPENMAN_WS_PORT: '18643', OPENMAN_NETWORK_AUDIT: join(root, 'network-attempts'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', data => { log = (log + data).slice(-20000); }); backend.stderr.on('data', data => { log = (log + data).slice(-20000); });
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error(`Server exited (${backend.exitCode})`);
    if (log.includes("Failed to prepare server")) throw new Error("Production server initialization failed");
    try { const response = await fetch(base + '/api/auth/session', { signal: AbortSignal.timeout(1500) }); if (response.ok) { assert.equal((await response.json()).session.userId, 'local-user'); ready = true; break; } } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 500));
  }
  assert(ready, 'Production server must start without cloud keys');
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    const data = await response.json(); assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`); return data;
  };
  assert.equal((await fetch(base + '/api/local/ready')).status, 403);
  assert.equal((await fetch(base + '/api/local/ready', {headers:{Authorization:'Bearer wrong-instance'}})).status, 403);
  assert.equal((await request('/api/local/ready', 'GET', undefined, {Authorization:'Bearer test-desktop-instance-token'})).ready, true);
  assert.equal((await fetch(base + '/api/local/ready', {headers:{Authorization:'Bearer test-desktop-instance-token',Origin:base}})).status,403);
  assert.equal((await request('/api/me')).user.plan, 'Local');
  assert.equal((await request('/api/me/provision')).state, 'ready');
  assert.equal((await request('/api/me/provision', 'POST')).state, 'ready');
  const computers = await request('/api/computers'); assert(JSON.stringify(computers).includes('local-host'));
  assert((await request('/api/computers/local-host/terminal', 'POST')).ticket);
  assert.equal(await new Promise((resolve, reject) => { const req = httpRequest(base + '/api/tasks', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }), 403);
  assert.equal((await fetch(base + '/api/tasks', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  await request('/api/local/models', 'PUT', { provider: 'ollama', model: 'smoke', baseUrl: `http://127.0.0.1:${model.address().port}/v1` });
  const created = await request('/api/tasks', 'POST', { prompt: 'Write the local production smoke test file.', mode: 'standard', interaction: 'agent' });
  const taskId = created.task.id;
  const connector = await request('/api/connectors/custom', 'POST', {kind:'mcp',name:'Production MCP',transport:'http',url:`http://127.0.0.1:${model.address().port}/mcp`});
  assert.equal(connector.connector.status,'ready');
  assert.equal(connector.connector.tools[0].name,'smoke-mcp');
  const enabledGenerators = (await request('/api/generators?refresh=1')).generators;
  assert.equal(enabledGenerators.find(g=>g.kind==='image').available,true);
  assert.equal(enabledGenerators.find(g=>g.kind==='video').available,false);
  await request(`/api/connectors/custom/${connector.connector.id}`, 'DELETE');
  const disabledGenerators = (await request('/api/generators?refresh=1')).generators;
  assert.equal(disabledGenerators.find(g=>g.kind==='image').available,false);
  assert.match(disabledGenerators.find(g=>g.kind==='image').needs,/MCP connector/);

  let completed = false;
  for (let i = 0; i < 60; i++) {
    const task = await request(`/api/tasks/${taskId}`);
    if (task.task.status === 'completed') { completed = true; break; }
    if (task.task.status === 'error') throw new Error(`Task failed: ${JSON.stringify(task)}`);
    await new Promise(r => setTimeout(r, 300));
  }
  assert(completed, 'Task must complete through UI API and relay');
  const finished = await request(`/api/tasks/${taskId}`);
  const start = finished.events.find(event=>event.type==='tool.started');
  const end = finished.events.find(event=>event.type==='tool.completed');
  assert(start && end, 'Tool progress must reach the UI');
  assert.equal(start.callId, end.callId);
  assert.equal(await readFile(join(root, 'workspace', 'production-result.txt'), 'utf8'), 'production agent result');
  const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'));
  const tick = await request('/api/cron/tick', 'POST', undefined, { Authorization: `Bearer ${secrets.CRON_SECRET}` }); assert(Array.isArray(tick.fired));
  assert.equal(await readFile(join(root, 'network-attempts'), 'utf8').catch(() => ''), '', 'No Orgo/Supabase network attempts');
  const page = await fetch(base + '/app'); assert(page.ok); assert(!page.headers.get('content-security-policy')?.includes('upgrade-insecure-requests'));
  console.log(`PASS production ${defaultMode ? 'default-local' : 'forced-local with remote Supabase configured'} offline boot, ` + ' auto-session, provisioning, computers, terminal ticket, CSRF/Host checks, UI task relay, real scheduler tick, production loopback MCP connector, authenticated readiness, native media capability detection, zero cloud attempts');
} catch (error) { console.error(log); throw error; }
finally {
  if (backend && backend.exitCode === null) { backend.kill('SIGTERM'); await new Promise(resolve => backend.once('exit', resolve)); }
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
