import { captureFrame, desktopInput, type DesktopInput } from "./desktop";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { resolveShell, wsPort } from "./host-client";
import { workspaceDir, appServerPort } from "./paths";

const ticketState = globalThis as typeof globalThis & { __desktopTickets?: Map<string, { expires: number; interactive: boolean }> };
const desktopTickets = ticketState.__desktopTickets ??= new Map();
export function mintDesktopTicket(interactive: boolean): string {
  for (const [id, ticket] of desktopTickets) if (ticket.expires < Date.now()) desktopTickets.delete(id);
  if (desktopTickets.size >= 1000) throw new Error("Too many pending desktop connections");
  const id = randomBytes(24).toString("hex"); desktopTickets.set(id, { expires: Date.now() + 30000, interactive }); return id;
}

const globalServices = globalThis as typeof globalThis & { __localServices?: Promise<Server> };
export function desktopToken(): string {
  return process.env.OPENMAN_DESKTOP_TOKEN ??= randomBytes(32).toString("hex");
}

/** Loopback-only terminal bridge. Browser origins are rejected; only the authenticated Next proxy connects. */
export function startHostServices(): Promise<Server> {
  return globalServices.__localServices ??= new Promise((resolve, reject) => {
    const token = desktopToken();
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const desktop = url.pathname === "/ws/desktop" ? desktopTickets.get(url.searchParams.get("ticket") ?? "") : undefined;
      let trustedOrigin = !req.headers.origin;
      if (req.headers.origin) {
        try { const origin = new URL(req.headers.origin); trustedOrigin = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && Number(origin.port || 80) === appServerPort(); } catch { /* invalid origin */ }
      }
      if (trustedOrigin && desktop && desktop.expires > Date.now()) {
        desktopTickets.delete(url.searchParams.get("ticket") ?? "");
        sockets.handleUpgrade(req, socket, head, (ws) => {
          let busy = false;
          const frame = async () => {
            if (busy || ws.readyState !== WebSocket.OPEN) return;
            busy = true;
            try { ws.send(JSON.stringify({ type: "frame", data: (await captureFrame()).toString("base64") })); }
            catch (error) { ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Capture unavailable" })); }
            finally { busy = false; }
          };
          const timer = setInterval(() => void frame(), 750); void frame();
          ws.on("close", () => clearInterval(timer));
          ws.on("message", (raw) => {
            if (!desktop.interactive) return;
            try { const input = JSON.parse(raw.toString()) as DesktopInput; void desktopInput(input).catch((error) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Input unavailable" })); }); } catch { /* malformed frame */ }
          });
        });
        return;
      }
      if (req.headers.origin || url.pathname !== "/ws/terminal" || url.searchParams.get("token") !== token) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
    });
    sockets.on("connection", async (ws, req) => {
      const queued: string[] = [];
      const handler: { current?: (raw: string) => void } = {};
      ws.on("message", (raw) => { if (handler.current) handler.current(raw.toString()); else if (queued.length < 32) queued.push(raw.toString()); });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const size = (name: string, fallback: number) => Math.max(5, Math.min(400, Number(url.searchParams.get(name)) || fallback));
      const send = (type: string, data: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data })); };
      let input: (s: string) => void;
      let resize: (cols: number, rows: number) => void = () => {};
      let kill: () => void;
      try {
        const ptyModule = "node-pty";
        const pty = await import(/* turbopackIgnore: true */ ptyModule) as { spawn: (shell: string, args: string[], options: unknown) => { write(s: string): void; resize(c: number, r: number): void; kill(): void; onData(fn: (s: string) => void): void; onExit(fn: (event: { exitCode: number }) => void): void } };
        const shell = pty.spawn(resolveShell(), process.platform === "win32" ? ["-NoLogo"] : ["-i"], {
          name: "xterm-256color", cols: size("cols", 120), rows: size("rows", 32), cwd: workspaceDir(),
          env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, TERM: "xterm-256color" },
        });
        input = (s) => shell.write(s); resize = (c, r) => shell.resize(c, r); kill = () => shell.kill();
        shell.onData((s) => send("output", s)); shell.onExit(({ exitCode }) => { send("exit", exitCode); ws.close(); });
      } catch {
        const shell = spawn(resolveShell(), process.platform === "win32" ? ["-NoLogo", "-Command", "-"] : ["-i"], {
          cwd: workspaceDir(), env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, TERM: "dumb" }, stdio: "pipe",
        });
        input = (s) => { shell.stdin.write(s); }; kill = () => { shell.kill("SIGKILL"); };
        shell.stdout.on("data", (s) => send("output", s.toString())); shell.stderr.on("data", (s) => send("output", s.toString()));
        shell.on("error", (e) => { send("error", e.message); ws.close(); });
        shell.on("exit", (code) => { send("exit", code); ws.close(); });
      }
      if (ws.readyState !== WebSocket.OPEN) { kill(); return; }
      handler.current = (raw: string) => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === "ping") send("pong", "");
          if (frame.type === "input" && typeof frame.data === "string") input(frame.data.slice(0, 16384));
          if (frame.type === "resize" && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)) resize(Math.max(5, Math.min(400, frame.cols)), Math.max(5, Math.min(200, frame.rows)));
        } catch { send("error", "Invalid terminal frame"); }
      };
      for (const raw of queued) handler.current(raw);
      ws.on("close", () => kill());
    });
    server.once("error", reject);
    server.listen(wsPort(), "127.0.0.1", () => resolve(server));
  });
}

export async function stopHostServices(): Promise<void> {
  const running = globalServices.__localServices;
  delete globalServices.__localServices;
  if (running) await new Promise<void>(async (resolve, reject) => {
    (await running).close((err) => err ? reject(err) : resolve());
  });
}
