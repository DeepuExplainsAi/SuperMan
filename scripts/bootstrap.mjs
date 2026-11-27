import { ensureBootstrap } from '../src/lib/local/bootstrap.ts';
const { created, appDataDir, workspaceDir } = ensureBootstrap();
console.log(JSON.stringify({ created, appDataDir, workspaceDir }));
