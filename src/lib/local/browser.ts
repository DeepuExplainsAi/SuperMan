import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appDataDir } from "./paths";
import { hostEnvironment } from "./process";
import { safeFetch } from "@/lib/net/safe-fetch";

const state = globalThis as typeof globalThis & { __nativeBrowser?: Promise<BrowserContext>; __nativeBrowserPersist?: boolean; __nativeBrowserTemp?: string };
const preference = () => join(appDataDir(), "browser-preference.json");
export async function browserPersists(): Promise<boolean> {
  try { return JSON.parse(await fs.readFile(preference(), "utf8")).persist !== false; } catch { return true; }
}
export async function closeNativeBrowser(): Promise<void> {
  const context = state.__nativeBrowser; state.__nativeBrowser = undefined;
  if (context) await (await context.catch(() => null))?.close();
  if (state.__nativeBrowserTemp) { await fs.rm(state.__nativeBrowserTemp, { recursive: true, force: true }); state.__nativeBrowserTemp = undefined; }
}
export async function setBrowserPersistence(persist: boolean): Promise<void> {
  await closeNativeBrowser(); await fs.mkdir(appDataDir(), { recursive: true });
  await fs.writeFile(preference(), JSON.stringify({ persist }), { mode: 0o600 });
}
export function browserExecutable(): string | undefined {
  const candidates = [process.env.OPENMAN_BROWSER_EXECUTABLE,
      ...(process.platform === "win32" ? [join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"), join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft/Edge/Application/msedge.exe")]
        : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
          : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"])];
  return candidates.find(path => path && existsSync(path));
}
async function context(): Promise<BrowserContext> {
  return state.__nativeBrowser ??= (async () => {
    const persistent = await browserPersists();
    state.__nativeBrowserPersist = persistent;
    const dir = persistent ? join(appDataDir(), "browser-profile") : await fs.mkdtemp(join(tmpdir(), "om-browser-"));
    if (!persistent) state.__nativeBrowserTemp = dir;
    const executablePath = browserExecutable();
    try {
      const ctx = await chromium.launchPersistentContext(dir, { ...(executablePath ? { executablePath } : { channel: "chrome" }), headless: process.env.OPENMAN_BROWSER_HEADLESS === "1", env: hostEnvironment() as Record<string, string>, acceptDownloads: false, timeout: 20000, serviceWorkers: "block" });
      // Browser network requests use the same DNS-pinned policy as server URL tools, including
      // redirects/subresources. A preflight HEAD alone would leave a DNS-rebinding gap.
      await ctx.route("**/*", async route => {
        const request = route.request();
        if (!/^https?:/.test(request.url())) { await route.abort("blockedbyclient"); return; }
        try {
          const headers: Record<string, string> = { ...await request.allHeaders(), "accept-encoding": "identity" };
          delete headers.host; delete headers["content-length"];
          const response = await safeFetch(request.url(), { method: request.method(), headers, body: request.postDataBuffer(), timeoutMs: 30000, maxBytes: 20000000, maxRedirects: 0 });
          const returned = Object.fromEntries(response.headers.entries());
          delete returned["transfer-encoding"]; delete returned["connection"]; delete returned["content-length"];
          await route.fulfill({ status: response.status, headers: returned, body: response.body });
        } catch { await route.abort("blockedbyclient").catch(() => {}); }
      });
      await ctx.routeWebSocket("**/*", socket => socket.close({ code: 1008, reason: "Browser network isolation" }));
      ctx.on("close", () => { state.__nativeBrowser = undefined; });
      return ctx;
    } catch { state.__nativeBrowser = undefined; throw new Error("Install Chrome, Chromium or Edge, or set OPENMAN_BROWSER_EXECUTABLE to its executable. No browser is downloaded automatically."); }
  })();
}
export async function nativeBrowserState(): Promise<{ persist: boolean; browserOpen: boolean; sites: { site: string; cookies: number; lastUsed: null; logins: [] }[] }> {
  const ctx = state.__nativeBrowser ? await state.__nativeBrowser.catch(() => null) : null;
  let cookies = ctx ? await ctx.cookies() : [];
  if (!ctx) {
    try { cookies = JSON.parse(await fs.readFile(join(appDataDir(), "browser-state.json"), "utf8")).cookies; } catch { /* no saved state */ }
  }
  const sites = new Map<string, number>();
  for (const cookie of cookies) { const site = cookie.domain.replace(/^\./, ""); sites.set(site, (sites.get(site) || 0) + 1); }
  return { persist: await browserPersists(), browserOpen: !!ctx, sites: [...sites].map(([site, count]) => ({ site, cookies: count, lastUsed: null, logins: [] })) };
}
export async function clearBrowserSite(site?: string): Promise<{ removedCookies: number; removedLogins: number }> {
  const ctx = await context(); const before = await ctx.cookies();
  if (site) { for (const cookie of before) if (cookie.domain.replace(/^\./, "") === site || cookie.domain.endsWith("." + site)) await ctx.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path }); }
  else { await ctx.clearCookies(); await closeNativeBrowser(); await fs.rm(join(appDataDir(), "browser-profile"), { recursive: true, force: true }); }
  const remaining = site ? (await ctx.cookies()).length : 0;
  if (await browserPersists()) await fs.writeFile(join(appDataDir(), "browser-state.json"), JSON.stringify({ cookies: site ? await ctx.cookies() : [] }), { mode: 0o600 });
  return { removedCookies: before.length - remaining, removedLogins: 0 };
}
export async function browserTool(input: Record<string, unknown>): Promise<string> {
  const ctx = await context(); const page = ctx.pages()[Number(input.tab) || 0] || await ctx.newPage();
  page.setDefaultTimeout(15000);
  switch (input.action) {
    case "navigate": {
      const url = new URL(String(input.url)); if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) browsing is allowed");
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30000 }); break;
    }
    case "click": await page.locator(String(input.selector)).first().click(); break;
    case "type": await page.locator(String(input.selector)).first().fill(String(input.text ?? "")); break;
    case "press": await page.keyboard.press(String(input.key)); break;
    case "tabs": return JSON.stringify(ctx.pages().map((p, tab) => ({ tab, url: p.url() })));
    case "close": await closeNativeBrowser(); return "Browser closed";
    case "read": break;
    default: throw new Error("Unknown browser action");
  }
  if (await browserPersists()) { const file = join(appDataDir(), "browser-state.json"); await fs.writeFile(file, JSON.stringify(await ctx.storageState()), { mode: 0o600 }); await fs.chmod(file, 0o600); }
  return JSON.stringify({ url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 40000) });
}

/** Website checkpoints use an ephemeral context, never the user's signed-in browser profile. */
export async function captureSitePreview(port: number, target: string): Promise<void> {
  if (!Number.isInteger(port) || port < 4100 || port > 4199) throw new Error("Invalid website preview port");
  const executablePath = browserExecutable();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: "chrome" }), headless: true, env: hostEnvironment() as Record<string, string>, timeout: 15000 });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 15000 });
    await fs.mkdir(join(target, ".."), { recursive: true });
    await page.screenshot({ path: target });
  } finally { await browser.close(); }
}
