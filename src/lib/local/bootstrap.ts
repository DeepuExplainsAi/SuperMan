// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Zero-config local bootstrap.
 *
 * On first launch OpenMan writes four 32-byte (64 hex char) secrets to a 0600-protected file under
 * the app config directory and loads them into `process.env`. From then on `src/lib/crypto.ts`, the
 * session layer and the scheduler read them with no `scripts/setup.mjs` and no `.env.local` editing.
 *
 * In a real Electron/desktop build these are scoped to the OS user. The same values are deterministic
 * for the life of the install; rotating them simply deletes the file and restarts.
 */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { appConfigDir, appDataDir, workspaceDir, ensureLocalDirs, secretsPath, isWindows } from "./paths";

export interface LocalSecrets {
  APP_DB_SECRET: string;
  SESSION_SECRET: string;
  APP_ENCRYPTION_KEY: string;
  CRON_SECRET: string;
}

export interface LocalConfig {
  secrets: LocalSecrets;
  appDataDir: string;
  workspaceDir: string;
  /** True when this run just created the secrets file. */
  created: boolean;
}

const SECRET_KEYS: (keyof LocalSecrets)[] = ["APP_DB_SECRET", "SESSION_SECRET", "APP_ENCRYPTION_KEY", "CRON_SECRET"];

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Lock a file down: chmod 0600 everywhere, and on Windows tighten the ACL to the owner only. */
function lockFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
  if (isWindows) {
    try {
      spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${process.env.USERNAME || "OWNER"}:R,W`], { stdio: "ignore" });
    } catch {
      // best effort
    }
  }
}

let cached: LocalConfig | null = null;

/**
 * Ensure the local secrets exist and are present in `process.env`. Idempotent and cheap after the
 * first call (reads the file once per process). Safe to call from any entry point (Next instrumentation,
 * Electron main, the standalone agent server, the integration test).
 */
export function ensureBootstrap(): LocalConfig {
  if (cached) return cached;
  ensureLocalDirs();
  const path = secretsPath();
  let created = false;
  let secrets: LocalSecrets;
  if (existsSync(/* turbopackIgnore: true */ path)) {
    try {
      const raw = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as Partial<LocalSecrets>;
      secrets = {
        APP_DB_SECRET: raw.APP_DB_SECRET || randomSecret(),
        SESSION_SECRET: raw.SESSION_SECRET || randomSecret(),
        APP_ENCRYPTION_KEY: raw.APP_ENCRYPTION_KEY || randomSecret(),
        CRON_SECRET: raw.CRON_SECRET || randomSecret(),
      };
      // Repair any missing keys without losing the rest.
      if (secrets.APP_DB_SECRET !== raw.APP_DB_SECRET || secrets.SESSION_SECRET !== raw.SESSION_SECRET || secrets.APP_ENCRYPTION_KEY !== raw.APP_ENCRYPTION_KEY || secrets.CRON_SECRET !== raw.CRON_SECRET) {
        writeFileSync(path, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
        lockFile(path);
      }
    } catch {
      throw new Error("Local secrets could not be read. Restore secrets.json from backup; refusing to rotate encryption keys automatically.");
    }
  } else {
    secrets = freshSecrets();
    writeFileSync(path, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
    lockFile(path);
    created = true;
  }

  // Surface into the environment for any module that reads these settings.
  for (const key of SECRET_KEYS) {
    if (!process.env[key]) process.env[key] = secrets[key];
    else secrets[key] = process.env[key]!;
  }
  if (!process.env.OPENMAN_LOCAL_MODE) process.env.OPENMAN_LOCAL_MODE = "1";

  cached = { secrets, appDataDir: appDataDir(), workspaceDir: workspaceDir(), created };
  return cached;
}

function freshSecrets(): LocalSecrets {
  return {
    APP_DB_SECRET: randomSecret(),
    SESSION_SECRET: randomSecret(),
    APP_ENCRYPTION_KEY: randomSecret(),
    CRON_SECRET: randomSecret(),
  };
}

/** The current secrets (after `ensureBootstrap`), or a fresh set if bootstrap has not run. */
export function localSecrets(): LocalSecrets {
  return ensureBootstrap().secrets;
}

/**
 * The SHA-256 hex of `APP_DB_SECRET` that the embedded DB's `private.server_secret` row is seeded
 * with. The local adapter bypasses RLS as the superuser, so this is informational, but we set it for
 * parity with the hosted model.
 */
export function serverSecretHash(): string {
  return createHash("sha256").update(localSecrets().APP_DB_SECRET).digest("hex");
}

export { appConfigDir, appDataDir, workspaceDir };
