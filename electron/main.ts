import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { app, desktopCapturer, BrowserWindow, screen, Menu, Tray, nativeImage, shell, ipcMain, session, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { brand } from "../src/config/brand";

let window: BrowserWindow | null = null;
let tray: Tray;
let backend: ChildProcess | undefined;
let quitting = false;
let backendReady = false;
const port = Number(process.env.OPENMAN_APP_PORT || 3000);
const origin = `http://127.0.0.1:${port}`;
const autoFile = join(process.env.XDG_CONFIG_HOME || join(app.getPath("home"), ".config"), "autostart", `${brand.wordmark}.desktop`);
function startsAtLogin(): boolean {
  return process.platform === "linux" ? existsSync(autoFile) : app.getLoginItemSettings().openAtLogin;
}
function autoStart(enabled: boolean): void {
  if (process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
  else if (enabled) {
    mkdirSync(join(autoFile, ".."), { recursive: true });
    writeFileSync(autoFile, `[Desktop Entry]\nType=Application\nName=${brand.name}\nExec="${process.env.APPIMAGE || process.execPath}"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
  } else if (existsSync(autoFile)) unlinkSync(autoFile);
}
function updateTray(): void {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Workspace", click: () => openWorkspace() },
    { label: "New Task", click: () => openWorkspace("/app") },
    { label: "Launch automatically when computer starts", type: "checkbox", checked: startsAtLogin(), click: (item) => { autoStart(item.checked); updateTray(); } },
    { type: "separator" }, { label: "Quit Completely", click: () => app.quit() },
  ]));
}
function openWorkspace(path = "/app"): void {
  if (!backendReady || quitting) return;
  if (window) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 600, title: brand.name, backgroundColor: "#171717",
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin + "/")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.on("closed", () => { window = null; });
  void window.loadURL(origin + path);
}
async function ready(): Promise<void> {
  process.env.OPENMAN_CAPTURE_TOKEN ??= randomBytes(32).toString("hex");
  process.env.OPENMAN_DESKTOP_INSTANCE_TOKEN ??= randomBytes(32).toString("hex");
  const capture = createServer(async (req, res) => {
    if (req.headers.origin || req.headers.authorization !== `Bearer ${process.env.OPENMAN_CAPTURE_TOKEN}`) { res.writeHead(403); res.end(); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: screen.getPrimaryDisplay().size });
      const image = sources[0]?.thumbnail;
      if (!image || image.isEmpty()) throw new Error("Screen capture permission denied");
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); res.end(image.toPNG());
    } catch { res.writeHead(503); res.end("Screen capture unavailable"); }
  });
  await new Promise<void>((resolve, reject) => { capture.once("error", reject); capture.listen(Number(process.env.OPENMAN_CAPTURE_PORT || 8644), "127.0.0.1", resolve); });
  app.on("before-quit", () => { capture.closeAllConnections(); capture.close(); });
  if (!process.env.OPENMAN_DESKTOP_DEV) {
    const root = join(process.resourcesPath, "server");
    backend = spawn(process.execPath, [join(root, "server.js")], { cwd: root, env: {
      ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", OPENMAN_LOCAL_MODE: "1", HOSTNAME: "127.0.0.1", PORT: String(port),
      OPENMAN_APP_DATA: app.getPath("userData"), OPENMAN_MIGRATIONS_DIR: join(root, "supabase", "migrations"),
    }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    backend.on("error", () => { if (!quitting) { dialog.showErrorBox(brand.name, "The local server could not start."); app.quit(); } });
    backend.on("exit", (code) => { if (!quitting) { dialog.showErrorBox(brand.name, `The local server exited (${code}). Restart the application.`); app.quit(); } });
    backend.stderr?.on("data", (data) => process.stderr.write(data));
    backend.stdout?.on("data", (data) => process.stdout.write(data));
  }
  const trusted = (url: string) => { try { return new URL(url).origin === origin; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(trusted(contents.getURL()) && new URL(contents.getURL()).pathname.startsWith("/app") && permission === "media" && (!("mediaTypes" in details) || (details.mediaTypes ?? []).every((type: string) => type === "audio"))));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => trusted(requestingOrigin) && permission === "media");
  ipcMain.handle("desktop:status", (event) => {
    if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Untrusted frame");
    return { platform: process.platform, autoStart: startsAtLogin(), version: app.getVersion() };
  });
  ipcMain.handle("desktop:auto-start", (event, enabled: unknown) => {
    if (!trusted(event.senderFrame?.url ?? "") || typeof enabled !== "boolean") throw new Error("Invalid request");
    autoStart(enabled); updateTray(); return startsAtLogin();
  });
  const icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : process.cwd(), "public", "brand", "icon.png"));
  tray = new Tray(icon.resize({ width: 22, height: 22 })); tray.setToolTip(brand.name); tray.on("click", () => openWorkspace()); updateTray();
  const marker = join(app.getPath("userData"), "desktop-initialized");
  if (!existsSync(marker)) { autoStart(true); mkdirSync(app.getPath("userData"), { recursive: true }); writeFileSync(marker, "1"); updateTray(); }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try { const res = await fetch(origin + "/api/local/ready", { headers: { Authorization: `Bearer ${process.env.OPENMAN_DESKTOP_INSTANCE_TOKEN}` }, signal: AbortSignal.timeout(1000) }); if (res.ok && (await res.json()).ready === true) { backendReady = true; openWorkspace(); return; } } catch { /* server warming */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("The local server did not become ready within two minutes.");
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => openWorkspace());
  app.whenReady().then(ready).catch((error) => { dialog.showErrorBox(brand.name, String(error)); app.quit(); });
  app.on("activate", () => openWorkspace());
  app.on("window-all-closed", () => { /* Tray keeps automations running. */ });
  app.on("before-quit", () => { quitting = true; backend?.kill(); });
}
