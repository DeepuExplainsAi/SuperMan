// macOS installers require macOS; dispatch the native-platform matrix rather than pretending to cross-build it.
import { execFileSync } from 'node:child_process';
try {
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (!branch) throw new Error('Run from a checked-out release branch.');
  execFileSync('gh', ['workflow', 'run', 'build-installers.yml', '--ref', branch], { stdio: 'inherit' });
  console.log('Native-platform builds dispatched. Use gh run list --workflow build-installers.yml to track artifacts.');
} catch {
  console.error('All-platform builds need the pushed GitHub Actions workflow and an authenticated GitHub CLI. Alternatively build dist:win, dist:linux, and dist:mac on their native hosts.');
  process.exitCode = 1;
}
