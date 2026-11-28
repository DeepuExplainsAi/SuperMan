#!/usr/bin/env node
// Preserve command output and surface a bounded failure tail in the check's API-readable annotations.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass a command and its arguments');
const child = spawn(command, args, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', chunk => { output.write(chunk); tail = (tail + chunk.toString()).slice(-6000); });
}
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  if (code === 0) return;
  if (process.env.GITHUB_ACTIONS) {
    const message = tail.replace(/\x1b\[[0-9;]*m/g, '').replace(/(https?:\/\/[^\s?]+)\?\S+/g, '$1?[redacted]')
      .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Command failed::${message}`);
  }
  process.exitCode = code || 1;
});
