#!/usr/bin/env node
// Exercise the actual packaged Electron Node runtime and bundled dependencies, not the builder's Node.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir, access } from 'node:fs/promises';
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
