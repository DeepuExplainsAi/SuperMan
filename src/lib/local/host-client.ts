/* eslint @typescript-eslint/no-unused-vars: ["warn", { "argsIgnorePattern": "^_" }] */
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * LocalHostClient — a drop-in replacement for `OrgoClient` that runs on the user's own laptop.
 *
 * The cloud `OrgoClient` reaches Orgo's API and a remote Linux VM. This client reaches only 127.0.0.1:
 * it executes shell commands via `node:child_process`, reads and writes files via `node:fs`, reports the
 * local machine's specs, and serves the local agent/websites/desktop streams. `request()` maps the Orgo
 * REST paths the app already calls onto local operations, so the existing routes and UI work unchanged.
 *
 * Every method here is cross-platform (Windows PowerShell / Git Bash, macOS zsh, Linux bash) and uses the
 * workspace + app-data directories from `src/lib/local/paths.ts` — never `/root` or GNU-only shell tricks.
 */
import { spawn } from "node:child_process";
import { cpus, totalmem, platform as osPlatform, homedir } from "node:os";
import { hostEnvironment } from "./process";
import { existsSync, statfsSync } from "node:fs";
import { workspaceDir, localComputerId, machineName, platform as omPlatform } from "./paths";

export class LocalHostError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) {
    super(message);
    this.name = "LocalHostError";
  }
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  timeoutMs?: number;
  guard?: (method: Method, path: string) => void;
}

export interface OrgoComputer {
  id: string;
  name: string;
  os?: string;
  ram?: number;
  cpu?: number;
  status?: string;
  disk_size_gb?: number | null;
  created_at?: string | null;
  ends_at?: string | null;
  host_id?: string | null;
  project_id?: string;
  vnc_password?: string | null;
  instance_details?: { resolution?: string | null; installedAgent?: string | null; templateTerminals?: { name?: string }[] | null } | null;
}

export function wsPort(): number {
  return Number(process.env.OPENMAN_WS_PORT || "8643");
}

export function localHostComputer(): OrgoComputer {
  const cpuCount = cpus().length || 1;
  const totalRamGb = Math.max(1, Math.round(totalmem() / 1073741824));
  const osMap: Record<string, string> = { win32: "windows", darwin: "macos", linux: "linux" };
  const os = osMap[osPlatform()] ?? "linux";
  return {
    id: localComputerId(),
    name: machineName(),
    os,
    ram: totalRamGb,
    cpu: cpuCount,
    status: "running",
    disk_size_gb: (() => { try { const disk = statfsSync(workspaceDir()); return Math.round(disk.blocks * disk.bsize / 1073741824); } catch { return null; } })(),
    created_at: null,
    ends_at: null,
    host_id: null,
    vnc_password: null,
    instance_details: { resolution: null, installedAgent: "hermes-local", templateTerminals: [{ name: "default" }] },
  };
}

export interface LocalHostClientOptions {
  apiKey?: string;
  workspaceId?: string | null;
  baseUrl?: string;
  guard?: (method: Method, path: string) => void;
}

export class LocalHostClient {
  readonly workspaceId: string | null;
  readonly baseUrl: string;
  readonly #guard?: (method: Method, path: string) => void;

  constructor({ workspaceId = null, baseUrl = "", guard }: LocalHostClientOptions = {}) {
    this.workspaceId = workspaceId;
    this.baseUrl = baseUrl;
    this.#guard = guard;
  }

  toJSON() {
    return { baseUrl: this.baseUrl, workspaceId: this.workspaceId, local: true };
  }

  /** Map an Orgo REST path onto a local operation. Covers every path the app actually calls. */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const verb = method.toUpperCase() as Method;
    if (verb !== "GET") { this.#guard?.(verb, path); opts.guard?.(verb, path); }
    const idMatch = path.match(/^\/computers\/([^/]+)/);
    const id = idMatch?.[1];
    const q = (p: string) => p.split("?")[0];
    const route = q(path);

    switch (`${verb} ${route}`) {
      case "GET /user/profile":
        return this.profile() as unknown as T;
      case "GET /user/subscription":
        return this.subscription() as unknown as T;
      case "GET /workspaces":
        return { workspaces: await this.workspaces() } as unknown as T;
      case "GET /user/usage/spend":
        return this.usage() as unknown as T;
      case "GET /credits/transactions":
        return { transactions: await this.transactions() } as unknown as T;
      case "GET /computers":
        return (await this.listComputers()) as unknown as T;
      case "POST /computers":
        return this.createComputer() as unknown as T;
      case "GET /computers/local-host":
      case `GET /computers/${id}`:
        return this.getComputer(id ?? localComputerId()) as unknown as T;
      case `DELETE /computers/${id}`:
        return this.deleteComputer() as unknown as T;
      case `POST /computers/${id}/start`:
      case `POST /computers/${id}/stop`:
      case `POST /computers/${id}/restart`:
      case `PATCH /computers/${id}/resize`:
      case `PATCH /computers/${id}/auto-stop`:
        return ({} as T);
      case `POST /computers/${id}/bash`:
        return this.bash(id ?? localComputerId(), (body as { command?: string; timeout?: number })?.command ?? "", (body as { timeout?: number })?.timeout) as unknown as T;
      case `GET /computers/${id}/agent`:
        return this.agentState(id ?? localComputerId()) as unknown as T;
      case `POST /computers/${id}/agent`:
      case `POST /computers/${id}/agent/install`:
        return this.agentSetup(id ?? localComputerId()) as unknown as T;
      case `GET /computers/${id}/agent/install`:
        return this.agentInstallState(id ?? localComputerId()) as unknown as T;
      case `GET /computers/${id}/public-urls`:
        return this.publicUrls(id ?? localComputerId()) as unknown as T;
      case `POST /computers/${id}/public-urls`:
        return this.createPublicUrl(id ?? localComputerId(), body as never) as unknown as T;
      case `PATCH /computers/${id}/public-urls/${idMatch?.[2] ?? ""}`:
        return this.updatePublicUrl(id ?? localComputerId(), "", body as never) as unknown as T;
      case `GET /computers/${id}/apps`:
        return this.apps(id ?? localComputerId()) as unknown as T;
      case "POST /credits/checkout":
      case "POST /billing/portal":
        throw new LocalHostError("Local mode has no billing or cloud credits.", 402, "no_billing");
      default:
        if (route.startsWith("/workspaces/")) return this.workspace(route.split("/")[2]) as unknown as T;
        throw new LocalHostError(`Local mode does not implement ${verb} ${route}.`, 404, "unsupported");
    }
  }

  /* ---- identity and plan (local) ---- */

  async profile() {
    return { id: "local-user", email: "local@localhost", full_name: "Local User", is_guest: false, subscription_status: "active" };
  }
  async subscription() {
    return { tier: "Local", requiresPayment: false };
  }
  async workspaces() {
    return [{ id: "local-workspace", name: "This Computer", user_id: "local-user", role: "owner", desktops: [localHostComputer()] }];
  }
  async workspace(_id?: string | null) {
    return (await this.workspaces())[0];
  }
  async members() {
    return [{ id: "local-user", email: "local@localhost", role: "owner" }];
  }
  async usage() {
    return { days: [], models: [], used_cents: 0 };
  }
  async transactions() {
    return [];
  }

  async credits() { return { tier: "Local", balanceCents: null }; }
  async keys() { return []; }

  /* ---- computers (the local machine) ---- */

  async listComputers(): Promise<OrgoComputer[]> {
    return [localHostComputer()];
  }
  async getComputer(id: string): Promise<OrgoComputer> {
    if (id !== localComputerId()) throw new LocalHostError("Local mode has only one computer: your own laptop.", 404, "no_computer");
    return localHostComputer();
  }
  createComputer(): never {
    throw new LocalHostError("Local mode uses your own computer — there is no cloud VM to create.", 400, "no_cloud");
  }
  deleteComputer(): never {
    throw new LocalHostError("You cannot delete your own computer.", 400, "no_delete");
  }
  setAutoStop() {
    return {};
  }

  /** Runs a shell command on the local machine. Cross-platform. A non-zero exit is returned, not thrown. */
  async bash(_id: string, command: string, timeout = 60, signal?: AbortSignal): Promise<{ success: boolean; output: string; exit_code: number | null; error: string | null }> {
    const { output, exitCode, error } = await runShell(resolveShell(), buildShellArgs(), command, Math.max(1, Math.min(300, Math.round(timeout))) * 1000, signal);
    return { success: exitCode === 0, output, exit_code: exitCode, error };
  }

  /** Local desktop stream URL (no VNC password needed on loopback). */
  async vncPassword(_id: string) {
    return { password: "", desktop_api_token: process.env.OPENMAN_DESKTOP_TOKEN || "" };
  }
  vncSocketUrl(_id: string, _password = ""): string {
    return `ws://127.0.0.1:${wsPort()}/ws/desktop`;
  }

  /* ---- the agent on the local machine ---- */

  async agentState(_id: string) {
    return { agent: "hermes-local", state: "ready", paired: true, models: "own", model: null, provider: "local", managed: false };
  }
  async agentSetup(_id: string, _agent = "hermes") {
    return { agent: "hermes-local", state: "installed", paired: true, models: "own", model: null, provider: "local", managed: false };
  }
  agentInstall(_id: string, _agent = "hermes") {
    return { state: "installed" };
  }
  agentInstallState(_id: string, _agent = "hermes") {
    return { state: "installed", failure: null };
  }

  /* ---- local app/website publishing ---- */

  async publicUrls(_id: string) {
    return { enabled: true, can_publish: true, can_share: false, public_urls: [] };
  }
  createPublicUrl(_id: string, body: { port: number; name?: string; password?: string }) {
    return { id: `local-${body.port}`, url: `http://127.0.0.1:${body.port}`, hostname: "127.0.0.1", label: body.name ?? "", port: body.port, access: "link", has_password: false };
  }
  updatePublicUrl(_id: string, _urlId: string, _body: Record<string, unknown>) {
    return { id: _urlId, url: "http://127.0.0.1", hostname: "127.0.0.1", label: "", port: 0, access: "link", has_password: false };
  }
  async apps(_id: string) {
    return { enabled: true, apps: [] };
  }
  createApp(_id: string, body: { port: number; title: string }) {
    return { id: `local-${body.port}`, title: body.title, url: `http://127.0.0.1:${body.port}`, hostname: "127.0.0.1", port: body.port, access: "link", state: "running" };
  }
}

/* ---------------------------------------------------------------- shell */

/** Pick the best local shell: PowerShell/pwsh on Windows, bash/zsh elsewhere. */
export function resolveShell(): string {
  if (osPlatform() === "win32") {
    return "powershell.exe";
  }
  for (const cand of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (existsSync(/* turbopackIgnore: true */ cand)) return cand;
  }
  return "/bin/sh";
}

/** Args so the shell reads the command from stdin (works on bash, zsh, pwsh, cmd). */
function buildShellArgs(): string[] {
  if (osPlatform() === "win32") return ["-NoProfile", "-NonInteractive", "-Command", "-"];
  return ["-s"];
}

interface ShellResult {
  output: string;
  exitCode: number | null;
  error: string | null;
}

function runShell(shell: string, args: string[], command: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ output: "", exitCode: null, error: "Command cancelled" }); return; }
    const isWin = osPlatform() === "win32";
    const child = spawn(shell, args, {
      cwd: workspaceDir(),
      env: { ...hostEnvironment(), OPENMAN_HOME: workspaceDir(), HOME: homedir() },
      windowsHide: true, detached: !isWin,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const onData = (b: Buffer) => { if (out.length < 2000000) out += b.toString("utf8"); };
    const onErr = (b: Buffer) => { if (err.length < 200000) err += b.toString("utf8"); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErr);
    let killed = false;
    const kill = () => {
      killed = true;
      if (!child.pid) return;
      if (isWin) { const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); taskkill.on("error", () => child.kill("SIGKILL")); }
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdin?.on("error", () => {});

    const finish = (exitCode: number | null, error: string | null) => {
      clearTimeout(timer); signal?.removeEventListener("abort", kill);
      resolve({ output: out, exitCode, error });
    };

    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code, killed ? (signal?.aborted ? "Command cancelled" : `Timed out after ${timeoutMs}ms`) : err || null));

    try {
      if (isWin) {
        child.stdin?.end(`${command}\nif ($?) { exit 0 } else { exit 1 }`);
      } else {
        child.stdin?.end(`${command}\nexit $?`);
      }
    } catch {
      finish(null, "Failed to send command to shell.");
    }
  });
}

export { omPlatform };
