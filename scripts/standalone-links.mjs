import { cp, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** WiX cannot package Next's directory aliases as files; materialize them before building installers. */
export async function materializeExternalAliases(standalone) {
  const root = await realpath(standalone);
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        const rel = relative(root, target);
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
          throw new Error(`Standalone alias escapes bundle: ${path}`);
        }
        await rm(path, { recursive: true, force: true });
        await cp(target, path, { recursive: true, dereference: true });
      } else if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(resolve(root, '.next', 'node_modules'));
}
