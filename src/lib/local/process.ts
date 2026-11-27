import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { workspaceDir, appDataDir } from "./paths";

/** Do not expose application credentials to arbitrary shell commands or generated websites. */
export function hostEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:APP_DB_SECRET|APP_ENCRYPTION_KEY|SESSION_SECRET|CRON_SECRET|OPENMAN_.*TOKEN|ELECTRON_RUN_AS_NODE)$/.test(key)) delete env[key];
  env.OPENMAN_HOME = workspaceDir();
  env.OPENMAN_GENERATOR_HOME = join(appDataDir(), ".openman");
  return env;
}
export function runProgram(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? workspaceDir(), env: hostEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const add = (data: Buffer) => { if (output.length < 2000000) output += data.toString(); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ output, exitCode: code ?? -1 }); });
  });
}
let python: { command: string; prefix: string[] } | undefined;
export function resolvePython(): { command: string; prefix: string[] } {
  if (python) return python;
  const candidates = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  for (const [command, ...prefix] of candidates) {
    const probe = spawnSync(/* turbopackIgnore: true */ command, [...prefix, "-c", "import sys; sys.exit(0 if sys.version_info.major == 3 else 1)"], { timeout: 5000, windowsHide: true });
    if (probe.status === 0) return python = { command, prefix };
  }
  throw new Error("This feature needs Python 3. Install Python 3 and restart the application.");
}
export async function runPython(args: string[], timeoutSec = 60): Promise<string> {
  const { command, prefix } = resolvePython();
  const result = await runProgram(command, [...prefix, ...args], { timeoutMs: timeoutSec * 1000 });
  if (result.exitCode !== 0) throw new Error(`Python helper failed (${result.exitCode}): ${result.output.slice(-500)}`);
  return result.output;
}
