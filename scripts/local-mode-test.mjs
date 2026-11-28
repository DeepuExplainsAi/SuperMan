#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const script of ['./local-mode.integration.mjs', './local-migrations-test.mjs']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(script, import.meta.url))], { stdio: 'inherit', env: process.env, timeout: 180000 });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
