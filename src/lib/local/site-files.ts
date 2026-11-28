import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { appDataDir } from "./paths";
import { runProgram, runPython } from "./process";

export async function siteGit(folder: string, args: string[]): Promise<string> {
  const result = await runProgram("git", ["-c", "commit.gpgsign=false", ...args], { cwd: folder, timeoutMs: 40000 });
  if (result.exitCode !== 0) throw new Error(`Website git operation failed: ${result.output.slice(-300)}`);
  return result.output.trim();
}
export async function commitSite(folder: string, message: string): Promise<string> {
  await siteGit(folder, ["add", "-A"]);
  const diff = await runProgram("git", ["diff", "--cached", "--quiet"], { cwd: folder });
  if (diff.exitCode !== 0) await siteGit(folder, ["commit", "-qm", message.slice(0, 120)]);
  return siteGit(folder, ["rev-parse", "HEAD"]);
}
export async function archiveSite(folder: string): Promise<{ name: string; bytes: Buffer }> {
  const dir = await fs.mkdtemp(join(appDataDir(), "site-export-"));
  try {
    const script = join(dir, "archive.py"), target = join(dir, "source.tar.gz");
    await fs.writeFile(script, `import os, sys, tarfile\nsource=os.path.realpath(sys.argv[1])\nname=os.path.basename(source)\ndef accept(info):\n    parts=info.name.replace('\\\\','/').split('/')[1:]\n    if info.issym() or info.islnk() or any(p.startswith('.') or p in ('node_modules','dist','__pycache__') for p in parts): return None\n    return info\nwith tarfile.open(sys.argv[2],'w:gz') as archive:\n    archive.add(source,arcname=name,filter=accept)\n`, { mode: 0o600 });
    await runPython([script, folder, target], 120);
    const info = await fs.stat(target);
    if (info.size > 100 * 1024 * 1024) throw new Error("Website export exceeds 100 MB");
    return { name: `${basename(folder)}.tar.gz`, bytes: await fs.readFile(target) };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
