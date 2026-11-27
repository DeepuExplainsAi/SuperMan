import { randomBytes } from "node:crypto";
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Share these before either process starts; the Electron capture broker must recognize the Next backend.
process.env.OPENMAN_CAPTURE_TOKEN ??= randomBytes(32).toString('hex');
process.env.OPENMAN_DESKTOP_INSTANCE_TOKEN ??= randomBytes(32).toString('hex');
const run = (args, env = {}) => spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });
const compiler = run([require.resolve('typescript/bin/tsc'), '-p', 'electron/tsconfig.json']);
if (await new Promise(r => compiler.on('exit', r))) process.exit(1);
const server = run([require.resolve('next/dist/bin/next'), 'dev', '-H', '127.0.0.1'], { OPENMAN_LOCAL_MODE: '1' });
const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env: { ...process.env, OPENMAN_DESKTOP_DEV: '1' } });
const stop = () => { server.kill(); electron.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
electron.on('exit', () => { server.kill(); });
server.on('exit', () => { electron.kill(); });
