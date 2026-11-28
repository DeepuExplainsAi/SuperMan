#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { materializeExternalAliases } from './standalone-links.mjs';
const root = await mkdtemp(join(process.cwd(), '.data-standalone-links-'));
try {
  const bundle = join(root, '.next', 'standalone');
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
  // Exercise electron-builder's real copy filters: root node_modules is deliberately skipped unless explicitly mapped.
  const require = createRequire(import.meta.url);
  const { load } = require('js-yaml');
  const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
  const config = load(await readFile('electron-builder.yml', 'utf8'));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public', 'asset.txt'), 'public asset');
  const destination = join(root, 'release', 'resources');
  const matchers = getFileMatchers(config, 'extraResources', destination, {
    defaultSrc: root, globalOutDir: join(root, 'release'), customBuildOptions: {}, macroExpander: value => value,
  });
  await copyFiles(matchers, null);
  assert.equal(await readFile(join(destination, 'server', 'node_modules', 'fixture', 'package.json'), 'utf8'), '{"name":"fixture"}');
  assert.equal(await readFile(join(destination, 'server', '.next', 'node_modules', '@scope', 'fixture-hash', 'package.json'), 'utf8'), '{"name":"fixture"}');
  assert.equal(await readFile(join(destination, 'public', 'asset.txt'), 'utf8'), 'public asset');
  const escape = join(aliases, 'outside');
  await symlink(root, escape, 'junction');
  await assert.rejects(materializeExternalAliases(bundle), /escapes bundle/);
  assert.equal((await lstat(escape)).isSymbolicLink(), true);
  console.log('PASS standalone aliases materialize, remain idempotent, package root dependencies, and refuse escaped targets');
} finally { await rm(root, { recursive: true, force: true }); }
