import { createServer, type Server } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { appDataDir, sitesDir } from "./paths";
import { hostEnvironment } from "./process";
import { resolveShell } from "./host-client";

export interface SiteService { id: string; folder: string; root: string; port: number; command?: string; program?: string; args?: string[]; persistent: boolean }
const g = globalThis as typeof globalThis & { __siteServices?: Map<string, { spec: SiteService; process?: ChildProcess; server?: Server; stopping?: boolean; restart?: ReturnType<typeof setTimeout> }> };
const running = g.__siteServices ??= new Map();
const configFile = () => join(appDataDir(), "site-services.json");
function persist(): void {
  mkdirSync(appDataDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify([...running.values()].filter((entry) => entry.spec.persistent).map((entry) => entry.spec)), { mode: 0o600 });
}
function inside(root: string, file: string): boolean { const rel = relative(root, file); return !rel.startsWith("..") && !isAbsolute(rel); }
export async function stopSiteService(id: string): Promise<void> {
  const entry = running.get(id); if (!entry) return;
  entry.stopping = true; clearTimeout(entry.restart); running.delete(id); persist();
  if (entry.process?.pid) {
    if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(entry.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("error", () => entry.process?.kill()); }
    else { try { process.kill(-entry.process.pid, "SIGTERM"); } catch { entry.process.kill("SIGTERM"); } }
  }
  if (entry.server) { entry.server.closeAllConnections(); await new Promise<void>((resolve) => entry.server!.close(() => resolve())); }
}
export async function startSiteService(spec: SiteService): Promise<string> {
  if (!((spec.port >= 4100 && spec.port <= 4199) || (spec.port >= 4300 && spec.port <= 4399))) throw new Error("Invalid local site port");
  const folder = await realpath(/* turbopackIgnore: true */ spec.folder); const allowed = await realpath(/* turbopackIgnore: true */ sitesDir());
  if (!inside(allowed, folder) || !inside(folder, resolve(spec.root))) throw new Error("Site outside workspace");
  if (running.has(spec.id)) await stopSiteService(spec.id);
  const entry: { spec: SiteService; process?: ChildProcess; server?: Server; stopping?: boolean; restart?: ReturnType<typeof setTimeout> } = { spec };
  running.set(spec.id, entry);
  try {
  if (spec.command || spec.program) {
    const shellCommand = spec.command?.replace(/\$PORT\b/g, process.platform === "win32" ? "$env:PORT" : "$PORT");
    const child = spawn(spec.program || resolveShell(), spec.program ? spec.args || [] : process.platform === "win32" ? ["-NoProfile", "-Command", shellCommand!] : ["-c", shellCommand!], {
      cwd: folder, env: { ...hostEnvironment(), ...(spec.program === process.execPath && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), OM_SITE_DIR: folder, OM_ROOT: spec.root, OM_PUBLISHED: spec.persistent ? "1" : "0", OPENMAN_SITE_KIT: join(appDataDir(), "site-kit"), PORT: String(spec.port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" }, detached: process.platform !== "win32", windowsHide: true, stdio: "ignore",
    });
    entry.process = child;
    let launchError: Error | undefined;
    child.on("error", error => { launchError = error; });
    child.on("exit", () => {
      if (!entry.stopping && spec.persistent && running.get(spec.id) === entry) {
        entry.restart = setTimeout(() => { if (!entry.stopping && running.get(spec.id) === entry) void startSiteService(spec).catch(() => {}); }, 5000);
        entry.restart.unref();
      }
    });
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !entry.stopping) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      ready = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: "127.0.0.1", port: spec.port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(300); socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.once("timeout", () => done(false));
      });
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) { await stopSiteService(spec.id); throw new Error("Website did not start listening on its loopback port within 20 seconds."); }
  } else {
    const root = await realpath(/* turbopackIgnore: true */ spec.root);
    if (!inside(folder, root)) throw new Error("Site root resolves outside workspace");
    entry.server = createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
        if (pathname.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules")) throw new Error("Hidden file");
        let file = resolve(root, `.${pathname}`);
        if (!inside(root, file)) throw new Error("Outside site");
        if ((await stat(/* turbopackIgnore: true */ file)).isDirectory()) file = join(file, "index.html");
        file = await realpath(/* turbopackIgnore: true */ file); if (!inside(root, file) || relative(root, file).split(/[\\/]/).some((part) => part.startsWith(".") || part === "node_modules")) throw new Error("Outside site");
        const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
        res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" }); res.end(await readFile(/* turbopackIgnore: true */ file));
      } catch { res.writeHead(404); res.end("Not found"); }
    });
    await new Promise<void>((resolve, reject) => { entry.server!.once("error", reject); entry.server!.listen(spec.port, "127.0.0.1", resolve); });
  }
  persist(); return `http://127.0.0.1:${spec.port}`;
  } catch (error) { if (running.get(spec.id) === entry) await stopSiteService(spec.id); throw error; }
}
export async function restoreSiteServices(): Promise<void> {
  if (!existsSync(/* turbopackIgnore: true */ configFile())) return;
  let saved: SiteService[];
  try { saved = JSON.parse(readFileSync(/* turbopackIgnore: true */ configFile(), "utf8")) as SiteService[]; }
  catch { console.warn("[local-sites] Could not read saved website services."); return; }
  if (!Array.isArray(saved)) return;
  for (const spec of saved) if (spec.persistent) await startSiteService(spec).catch(() => {});
}

// Child process groups must not outlive Quit Completely. Keep the persisted specifications
// intact so the next launch can restore releases, but terminate the actual host processes.
const lifecycle = globalThis as typeof globalThis & { __siteExitCleanup?: boolean };
if (!lifecycle.__siteExitCleanup) {
  lifecycle.__siteExitCleanup = true;
  process.once("exit", () => {
    for (const entry of running.values()) {
      entry.stopping = true; clearTimeout(entry.restart);
      if (!entry.process?.pid) continue;
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(entry.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 3000 });
      else { try { process.kill(-entry.process.pid, "SIGKILL"); } catch { /* already stopped */ } }
    }
  });
}
