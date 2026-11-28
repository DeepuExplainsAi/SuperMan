// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Cross-platform paths for 100% local desktop operation.
 *
 * Everything OpenMan keeps on disk lives under one of two roots chosen per OS:
 *  - the *app data* directory (secrets, the embedded database, logs, browser profile)
 *  - the *workspace* directory (task files, uploads, generated sites, voice notes)
 *
 * No path in the local engine ever hard-codes `/root`, `/tmp`, `$HOME` shell expansion or
 * GNU-only commands: every location is resolved here with `node:path` so the same code runs
 * on Windows (NTFS), macOS and Linux.
 */
import { brand } from "@/config/brand";
import { homedir, platform as osPlatform, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export type Platform = "windows" | "macos" | "linux";

const RAW_PLATFORM = osPlatform();

export function platform(): Platform {
  if (RAW_PLATFORM === "win32") return "windows";
  if (RAW_PLATFORM === "darwin") return "macos";
  return "linux";
}

export const isWindows = platform() === "windows";
export const isMacos = platform() === "macos";
export const isLinux = platform() === "linux";

/**
 * Local Desktop Mode is the DEFAULT. It is only turned off when a remote Supabase project is
 * explicitly configured (env `NEXT_PUBLIC_SUPABASE_URL`), or the operator sets
 * `OPENMAN_LOCAL_MODE=0`/`false`. In Local Mode the app talks to nothing but 127.0.0.1.
 */
export function isLocalMode(): boolean {
  const v = process.env.OPENMAN_LOCAL_MODE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  // Default on, unless a remote database is explicitly configured.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) return false;
  return true;
}

/** Product name used for directory names; overridable via env for forks. */
function productName(): string {
  return (process.env.OPENMAN_PRODUCT_NAME?.trim() || brand.name).replace(/[^A-Za-z0-9_-]/g, "");
}

/** The application data root (secrets, embedded DB, logs). */
export function appDataDir(): string {
  if (process.env.OPENMAN_APP_DATA) return resolve(process.env.OPENMAN_APP_DATA);
  const name = productName();
  switch (platform()) {
    case "windows":
      return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), name);
    case "macos":
      return join(homedir(), "Library", "Application Support", name);
    default:
      // Linux: XDG data dir, falling back to ~/.local/share.
      return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), name.toLowerCase() || brand.wordmark);
  }
}

/** A separate config directory on Linux (XDG_CONFIG_HOME), else the app data dir. */
export function appConfigDir(): string {
  if (process.env.OPENMAN_APP_DATA) return appDataDir();
  if (platform() === "linux") {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), (productName() || brand.wordmark).toLowerCase());
  }
  return appDataDir();
}

/** The user's workspace: where tasks, uploads, generated sites and voice notes live. */
export function workspaceDir(): string {
  if (process.env.OPENMAN_WORKSPACE) return resolve(process.env.OPENMAN_WORKSPACE);
  const name = `${productName()}Workspace`;
  switch (platform()) {
    case "windows":
      return join(process.env.USERPROFILE || homedir(), name);
    default:
      return join(homedir(), name);
  }
}

export function pgDataDir(): string {
  return join(appDataDir(), "pgdata");
}

export function localConfigPath(): string {
  return join(appConfigDir(), "local-config.json");
}

export function secretsPath(): string {
  return join(appConfigDir(), "secrets.json");
}

/** Per-task working directory inside the workspace. */
export function taskDir(taskId: string): string {
  return join(workspaceDir(), "tasks", sanitize(taskId));
}

export function uploadsDir(): string {
  return join(workspaceDir(), "uploads");
}

export function sitesDir(): string {
  return join(workspaceDir(), "sites");
}

export function incomingDir(): string {
  return join(appDataDir(), "incoming");
}

export function voiceDir(): string {
  return join(appDataDir(), "voice");
}

export function browserDataDir(): string {
  return join(appDataDir(), "browser-data");
}

export function agentDataDir(): string {
  return join(appDataDir(), "agent");
}

export function logsDir(): string {
  return join(appDataDir(), "logs");
}

export function autostartDir(): string {
  // Linux XDG autostart.
  if (platform() === "linux") {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart");
  }
  return appConfigDir();
}

/** The embedded local agent runtime listens here by default. */
export function agentServerUrl(): string {
  const port = Number(process.env.OPENMAN_AGENT_PORT || "8642");
  return `http://127.0.0.1:${port}`;
}

/** The embedded Next.js server binds this loopback port by default. */
export function appServerPort(): number {
  return Number(process.env.PORT || process.env.OPENMAN_APP_PORT || "3000");
}

/** Remove characters unsafe for a path segment across operating systems. */
export function sanitize(name: string): string {
  return name.replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 200) || "default";
}

/** Create a directory (and parents) if missing. Returns the path. */
export function ensureDir(dir: string): string {
  if (!existsSync(/* turbopackIgnore: true */ dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ensure all local directories exist. Call once at boot. */
export function ensureLocalDirs(): { appData: string; workspace: string } {
  ensureDir(appDataDir());
  ensureDir(appConfigDir());
  ensureDir(workspaceDir());
  ensureDir(pgDataDir());
  ensureDir(uploadsDir());
  ensureDir(sitesDir());
  ensureDir(incomingDir());
  ensureDir(voiceDir());
  ensureDir(browserDataDir());
  ensureDir(agentDataDir());
  ensureDir(logsDir());
  return { appData: appDataDir(), workspace: workspaceDir() };
}

/** A stable id for the local machine owner (used as the local session user). */
export function localUserId(): string {
  return "local-user";
}

export function localWorkspaceId(): string {
  return "local-workspace";
}

export function localComputerId(): string {
  return "local-host";
}

export function machineName(): string {
  try {
    return (process.env.COMPUTERNAME || process.env.HOSTNAME || userInfo().username || "this computer").toString();
  } catch {
    return "this computer";
  }
}
