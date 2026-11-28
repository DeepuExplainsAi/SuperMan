#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeExternalAliases } from './standalone-links.mjs';
const root = await mkdtemp(join(process.cwd(), '.data-standalone-links-'));
try {
  const bundle = join(root, 'standalone');
  const target = join(bundle, 'node_modules', 'fixture');
  const aliases = join(bundle, '.next', 'node_modules', '@scope');
  await mkdir(target, { recursive: true });
  await mkdir(aliases, { recursive: true });
  await writeFile(join(target, 'package.json'), '{"name":"fixture"}');
  const alias = join(aliases, 'fixture-hash');
  await symlink(target, alias, 'junction');
  await materializeExternalAliases(bundle);
  assert.equal((await lstat(alias)).isSymbolicLink(), false);
  assert.equal(await readFile(join(alias, 'package.json'), 'utf8'), '{"name":"fixture"}');
  await materializeExternalAliases(bundle);
  const escape = join(aliases, 'outside');
  await symlink(root, escape, 'junction');
  await assert.rejects(materializeExternalAliases(bundle), /escapes bundle/);
  assert.equal((await lstat(escape)).isSymbolicLink(), true);
  console.log('PASS standalone aliases materialize, remain idempotent, and refuse targets outside the bundle');
} finally { await rm(root, { recursive: true, force: true }); }
