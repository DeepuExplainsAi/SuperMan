import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Universal server resources need both sharp prebuilds, not just the builder host's optional packages. */
export async function prepareMacDependencies(standalone) {
  const sharp = JSON.parse(await readFile('node_modules/sharp/package.json', 'utf8'));
  const temporary = await mkdtemp(join(process.cwd(), '.data-mac-deps-'));
  try {
    for (const arch of ['x64', 'arm64']) {
      for (const name of [`@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`]) {
        const version = sharp.optionalDependencies[name];
        assert.match(version, /^\d+\.\d+\.\d+$/, 'Sharp prebuilds must use exact versions');
        const destination = join(standalone, 'node_modules', name);
        try {
          await access(join('node_modules', name, 'package.json'));
          await cp(join('node_modules', name), destination, { recursive: true });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const packed = JSON.parse(execFileSync('npm', ['pack', `${name}@${version}`, '--ignore-scripts', '--json', '--pack-destination', temporary], { encoding: 'utf8', timeout: 120000 }));
          await mkdir(destination, { recursive: true });
          execFileSync('tar', ['-xzf', join(temporary, packed[0].filename), '--strip-components=1', '-C', destination], { timeout: 60000 });
        }
        const installed = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
        assert.equal(installed.name, name);
        assert.equal(installed.version, version);
      }
      await access(join(standalone, 'node_modules/node-pty/prebuilds', `darwin-${arch}`, 'pty.node'));
      // npm's published prebuild helpers are mode 0644; posix_spawnp requires execute permission.
      await chmod(join(standalone, 'node_modules/node-pty/prebuilds', `darwin-${arch}`, 'spawn-helper'), 0o755);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
