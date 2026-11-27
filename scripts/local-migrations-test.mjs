#!/usr/bin/env node
// Restart the embedded DB across independent Node processes to prove persistent migration upgrades.
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = await mkdtemp(join(process.cwd(), '.data-migration-test-'));
const migrations = join(root, 'migrations');
const env = { ...process.env, OPENMAN_LOCAL_MODE: '1', OPENMAN_APP_DATA: root, OPENMAN_WORKSPACE: join(root, 'workspace'), OPENMAN_MIGRATIONS_DIR: migrations };
const run = (expectUpgrade) => {
  const source = `import assert from 'node:assert/strict';
import {getLocalDb} from './src/lib/local/db-adapter.ts';
const pg=await getLocalDb();
try {
  const result=await pg.query('select count(*)::int as n from _om_migrations');
  assert(result.rows[0].n>0);
  ${expectUpgrade ? "assert.equal((await pg.query('select count(*)::int as n from local_upgrade_probe')).rows[0].n,1); assert.equal((await pg.query(\"select count(*)::int as n from _om_migrations where name='20990101000000_local_upgrade_probe.sql'\")).rows[0].n,1);" : ''}
} finally {await pg.close();}`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), env, stdio: 'inherit', timeout: 60000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Migration subprocess exited with ${child.status}`);
};
try {
  await cp('supabase/migrations', migrations, { recursive: true });
  run(false);
  await writeFile(join(migrations, '20990101000000_local_upgrade_probe.sql'), 'create table public.local_upgrade_probe (id int primary key); insert into public.local_upgrade_probe values (1);');
  run(true);
  run(true);
  console.log('PASS persisted baseline, future migration after restart, and upgrade idempotency across independent processes');
} finally { await rm(root, { recursive: true, force: true }); }
