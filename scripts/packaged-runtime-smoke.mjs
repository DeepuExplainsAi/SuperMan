#!/usr/bin/env node
// Exercise the actual packaged Electron Node runtime and bundled dependencies, not the builder's Node.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir, access, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { _electron } from 'playwright-core';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { arch: { type: 'string' } } });
assert(['x64', 'arm64', 'ia32', 'universal'].includes(values.arch), 'Pass --arch x64|arm64|ia32|universal');
const require = createRequire(import.meta.url);
const { brand } = require('../build/electron/src/config/brand.js');
let executable, serverRoot;
if (process.platform === 'darwin') {
  const root = resolve('release/mac-universal');
  const apps = (await readdir(root)).filter(name => name.endsWith('.app'));
  assert.equal(apps.length, 1, 'Expected one packaged macOS app');
  executable = join(root, apps[0], 'Contents', 'MacOS', brand.name);
  serverRoot = join(root, apps[0], 'Contents', 'Resources', 'server');
} else {
  const platform = process.platform === 'win32' ? 'win' : 'linux';
  const root = resolve(`release/${platform}${values.arch === 'x64' ? '' : '-' + values.arch}-unpacked`);
  executable = join(root, process.platform === 'win32' ? brand.name + '.exe' : brand.wordmark);
  serverRoot = join(root, 'resources', 'server');
}
await access(executable);
await access(join(serverRoot, 'server.js'));
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, timeout: 180000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Packaged runtime check failed (${result.signal || result.status})`);
  return result;
}
const probe = run(executable, ['-p', 'JSON.stringify({arch:process.arch,electron:process.versions.electron})'], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
const runtime = JSON.parse(probe.stdout.trim());
assert(runtime.electron, 'Must test the packaged Electron binary');
assert.equal(runtime.arch, values.arch === 'universal' ? process.arch : values.arch);
console.log(`PASS packaged Electron ${runtime.electron} ${runtime.arch}`);
// This fails rather than silently falling back to a pipe if the shipped native terminal is missing/incompatible.
run(executable, ['-e', `
  const {createRequire}=require('node:module');
  const pty=createRequire(${JSON.stringify(join(serverRoot, 'package.json'))})('node-pty');
  const win=process.platform==='win32';
  const terminal=pty.spawn(win?'cmd.exe':'/bin/sh',win?['/d','/s','/c','echo PACKAGED_PTY_OK']:['-c','printf PACKAGED_PTY_OK'],{cols:80,rows:24,env:process.env});
  let output='';
  const timeout=setTimeout(()=>{terminal.kill();process.exit(1)},15000);
  terminal.onData(data=>output+=data);
  terminal.onExit(({exitCode})=>{clearTimeout(timeout);process.exit(exitCode===0&&output.includes('PACKAGED_PTY_OK')?0:1)});
`]);
console.log('PASS packaged native PTY load and execution');
run(process.execPath, ['scripts/local-production-smoke.mjs', '--executable', executable, '--server-root', serverRoot], { env: { ...process.env, OPENMAN_SMOKE_DEFAULT: '0' } });
run(process.execPath, ['scripts/local-production-smoke.mjs', '--executable', executable, '--server-root', serverRoot], { env: { ...process.env, OPENMAN_SMOKE_DEFAULT: '1' } });

// Launch the packaged GUI against isolated data. This does not simulate OS install wizards or permission dialogs.
const data = await mkdtemp(join(process.cwd(), '.data-packaged-gui-'));
const guiOrigin = 'http://127.0.0.1:3091';
let application, guiLog = '';
try {
  const guiEnv = { ...process.env, OPENMAN_APP_DATA: join(data, 'app'), OPENMAN_WORKSPACE: join(data, 'workspace'),
    XDG_CONFIG_HOME: join(data, 'config'), OPENMAN_APP_PORT: '3091', OPENMAN_AGENT_PORT: '18652', OPENMAN_WS_PORT: '18653',
    OPENMAN_CAPTURE_PORT: '18654', OPENMAN_DESKTOP_INSTANCE_TOKEN: randomBytes(32).toString('hex') };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  delete guiEnv.OPENMAN_DESKTOP_DEV;
  application = await _electron.launch({ executablePath: executable, env: guiEnv,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [], timeout: 180000 });
  for (const stream of [application.process().stdout, application.process().stderr]) {
    stream?.on('data', chunk => { guiLog = (guiLog + chunk.toString()).slice(-12000); });
  }
  const page = await application.firstWindow({ timeout: 180000 });
  await page.waitForURL(guiOrigin + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof window.desktop?.status === 'function');
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), join(data, 'app'));
  const status = await page.evaluate(() => window.desktop.status());
  assert.equal(status.platform, process.platform);
  assert.equal(status.autoStart, true, 'First launch must enable autostart');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined', 'Renderer must not have Node access');
  assert.equal(await page.evaluate(() => window.desktop.setAutoStart(false)), false);
  assert.equal(await page.evaluate(() => window.desktop.setAutoStart(true)), true);
  assert.equal(await page.evaluate(() => window.desktop.setAutoStart(false)), false);
  const session = await (await fetch(guiOrigin + '/api/auth/session')).json();
  assert.equal(session.session.userId, 'local-user');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert((await fetch(guiOrigin + '/api/me')).ok, 'Backend stays alive when window closes to tray');
  await application.evaluate(({ app }) => app.emit('activate'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  console.log('PASS packaged GUI boot, owner session, preload isolation, autostart toggles, close-to-tray and reopen');
} catch (error) {
  console.error(guiLog);
  throw error;
} finally {
  if (application) await application.close();
  // A clean quit must also stop the embedded backend, not leave it running under the runner account.
  const deadline = Date.now() + 15000;
  let stopped = false;
  while (Date.now() < deadline) {
    try { await fetch(guiOrigin + '/api/auth/session', { signal: AbortSignal.timeout(1000) }); }
    catch { stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(stopped, 'Packaged backend must stop when the desktop app quits');
  await rm(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
console.log('PASS packaged desktop shutdown; native install wizards and OS permission prompts still require acceptance testing');
