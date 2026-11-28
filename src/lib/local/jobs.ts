import { spawn } from "node:child_process";
import { promises as fs, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { hostEnvironment, resolvePython } from "./process";

const PREFIX = "OPENMAN_NATIVE_JOB\n";
/** A staged program, never a shell command (in particular never a shell-embedded credential). */
export function pythonJob(source: string, args: string[] = []): string {
  return PREFIX + JSON.stringify({ source, args });
}
export async function launchPythonJob(dir: string, descriptor: string): Promise<void> {
  if (!descriptor.startsWith(PREFIX)) throw new Error("This job does not support native desktop execution.");
  const job = JSON.parse(descriptor.slice(PREFIX.length)) as { source: string; args: string[] };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Creating the lock is atomic, including across hot-reloaded server instances.
  const lock = join(dir, "job.lock");
  try { await fs.mkdir(lock); } catch {
    const pid = Number(await fs.readFile(join(dir, "job.pid"), "utf8").catch(() => "0"));
    if (pid > 0) { try { process.kill(pid, 0); return; } catch { /* job exited */ } }
    const info = await fs.stat(lock);
    if (Date.now() - info.mtimeMs < 10000) return;
    await fs.rm(lock, { recursive: true, force: true });
    return launchPythonJob(dir, descriptor);
  }
  let fd: number | undefined;
  try {
    for (const name of ["out.json", "out.json.tmp", "out.json.progress", "job.exit"]) await fs.rm(/* turbopackIgnore: true */ join(dir, name), { force: true });
    const wrapper = `import os, subprocess, sys, json\nfrom pathlib import Path\ntry:\n    job=json.loads(Path('job.json').read_text(encoding='utf-8'))\n    result=subprocess.run([sys.executable, 'job.py', *job['args']])\n    code=result.returncode\nexcept Exception as error:\n    print(str(error), file=sys.stderr)\n    code=1\nPath('job.exit').write_text(str(code))\ntry: os.rmdir('job.lock')\nexcept OSError: pass\n`;
    await fs.writeFile(join(dir, "job.py"), job.source, { mode: 0o600 });
    await fs.writeFile(join(dir, "job.json"), JSON.stringify({ args: job.args }), { mode: 0o600 });
    await fs.writeFile(join(dir, "job-runner.py"), wrapper, { mode: 0o600 });
    fd = openSync(join(dir, "job.log"), "w", 0o600);
    const python = resolvePython();
    const child = spawn(python.command, [...python.prefix, "job-runner.py"], { cwd: dir, env: hostEnvironment(), detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await fs.writeFile(join(dir, "job.pid"), String(child.pid), { mode: 0o600 });
    child.unref();
  } catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export async function pythonJobState(dir: string): Promise<{ state: "running" | "done" | "failed"; output?: string; progress: { state: string; done: number; total: number } | null; error?: string }> {
  const output = await fs.readFile(join(dir, "out.json"), "utf8").catch(() => undefined);
  if (output !== undefined) return { state: "done", output, progress: null };
  let progress = null;
  try { progress = JSON.parse(await fs.readFile(join(dir, "out.json.progress"), "utf8")); } catch { /* not started */ }
  const exit = await fs.readFile(join(dir, "job.exit"), "utf8").catch(() => null);
  const pid = Number(await fs.readFile(join(dir, "job.pid"), "utf8").catch(() => "0"));
  if (exit === null && pid > 0) { try { process.kill(pid, 0); return { state: "running", progress }; } catch { /* exited */ } }
  const log = await fs.readFile(join(dir, "job.log"), "utf8").catch(() => "");
  return { state: "failed", progress, error: log.trim().split("\n").pop()?.slice(0, 300) || "Transcription stopped without a result." };
}
