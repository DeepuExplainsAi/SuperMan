#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const afterPack = require('./desktop-after-pack.cjs');
const { Arch } = require('builder-util');
const root = await mkdtemp(join(process.cwd(), '.data-after-pack-'));
const packager = { projectDir: root, appInfo: { productFilename: 'Fixture' } };
const resources = out => join(out, 'Fixture.app', 'Contents', 'Resources');
try {
  const staged = join(root, '.next', 'standalone');
  await mkdir(staged, { recursive: true });
  await writeFile(join(staged, 'server.js'), '// fixture server');
  await writeFile(join(staged, 'spawn-helper'), 'fixture helper');
  await chmod(join(staged, 'spawn-helper'), 0o755);
  await mkdir(join(root, 'public')); await writeFile(join(root, 'public', 'asset.txt'), 'asset');
  const temporary = join(root, 'mac-universal-x64-temp');
  await mkdir(join(resources(temporary), 'server'), { recursive: true });
  await writeFile(join(resources(temporary), 'server', 'unused.txt'), 'temporary');
  await afterPack({ electronPlatformName: 'darwin', arch: Arch.x64, appOutDir: temporary, packager });
  await assert.rejects(access(join(resources(temporary), 'server')), { code: 'ENOENT' });
  const out = join(root, 'mac-universal');
  await afterPack({ electronPlatformName: 'darwin', arch: Arch.universal, appOutDir: out, packager });
  assert.equal(await readFile(join(resources(out), 'server', 'server.js'), 'utf8'), '// fixture server');
  assert.equal(await readFile(join(resources(out), 'public', 'asset.txt'), 'utf8'), 'asset');
  if (process.platform !== 'win32') assert((await stat(join(resources(out), 'server', 'spawn-helper'))).mode & 0o111);
  await afterPack({ electronPlatformName: 'darwin', arch: Arch.x64, appOutDir: out, packager });
  await afterPack({ electronPlatformName: 'linux', arch: Arch.universal, appOutDir: out, packager });
  await access(join(resources(out), 'server', 'server.js'));
  await access(join(staged, 'server.js'));
  console.log('PASS universal resources restored after merging, execute bits retained, other packages and source untouched');
} finally { await rm(root, { recursive: true, force: true }); }
