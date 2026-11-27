// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Server-only database client (see docs/ARCHITECTURE.md, "Data").
 *
 * Two backends, selected by `OPENMAN_LOCAL_MODE` (default ON):
 *
 *  - Local Desktop Mode (the default): an embedded `@electric-sql/pglite` Postgres database persisted to
 *    `<appDataDir>/pgdata`, speaking the Supabase query-builder API the app's repositories already use. No
 *    remote Supabase, no network, no accounts. `initLocalDb()` must be awaited once at startup (the Next.js
 *    instrumentation hook and the Electron main process both do this); afterwards `db()` returns the ready client.
 *  - Optional remote Supabase: if `NEXT_PUBLIC_SUPABASE_URL` is set, the original hosted client is used
 *    (the access model described in the migrations still applies).
 *
 * Every repository in this folder takes a `userId` and scopes every query by it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isLocalMode } from "@/lib/local/paths";
import { getLocalDbClientSync, initLocalDb as adapterInitLocalDb, type LocalDbClient } from "@/lib/local/db-adapter";

const g = globalThis as typeof globalThis & { __omDb?: { client: SupabaseClient; fingerprint: string } };

/** True when the database is usable (local by default, remote when explicitly configured). */
export function dbConfigured(): boolean {
  if (isLocalMode()) return true;
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && process.env.APP_DB_SECRET);
}

/** Await once at server startup so the embedded database (and migrations) are ready before any request. */
export async function initLocalDb(opts?: { inMemory?: boolean; dataDir?: string; migrationsDir?: string }): Promise<LocalDbClient> {
  return adapterInitLocalDb(opts);
}

export function db(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("db() is server-only.");

  // Local Desktop Mode: use the embedded PGlite database — no remote Supabase required.
  if (isLocalMode()) {
    const local = getLocalDbClientSync();
    if (!local) throw new DbError("The local database has not been initialized yet. Call initLocalDb() at startup.", "init");
    // The local client satisfies the query-builder API the repositories rely on; the cast keeps every
    // existing call site type-compatible without rewriting business logic.
    return local as unknown as SupabaseClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.APP_DB_SECRET;
  if (!url || !key || !secret) throw new DbError("The database is not configured.", "config");
  const fingerprint = `${url}|${key}|${secret.length}`;
  if (g.__omDb?.fingerprint === fingerprint) return g.__omDb.client;
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-om-secret": secret } },
  });
  g.__omDb = { client, fingerprint };
  return client;
}

export class DbError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Throws a readable error for a failed query. */
export function fail(action: string, error: { message: string; code?: string }): never {
  throw new DbError(`Database ${action} failed: ${error.message}${error.code ? ` (${error.code})` : ""}`, error.code);
}

let reachable: { ok: boolean; at: number } | null = null;
/**
 * Whether the database answers. In Local Desktop Mode the embedded DB is always reachable, so this is true;
 * for a remote Supabase it is probed (cached 30 s / 10 s after a failure).
 */
export async function dbReachable(): Promise<boolean> {
  if (isLocalMode()) return true;
  if (!dbConfigured()) return false;
  const now = Date.now();
  if (reachable && now - reachable.at < (reachable.ok ? 30_000 : 10_000)) return reachable.ok;
  let ok = false;
  try {
    const { error } = await db().from("settings").select("user_id").limit(1).abortSignal(AbortSignal.timeout(4000));
    ok = !error;
  } catch {
    ok = false;
  }
  reachable = { ok, at: now };
  return ok;
}

export const iso = (v: string | null | undefined): string => (v ? new Date(v).toISOString() : "");
