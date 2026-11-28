// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Embedded local database adapter.
 *
 * A drop-in for `@supabase/supabase-js` built on `@electric-sql/pglite` (Postgres in WASM, persisted to
 * `<appDataDir>/pgdata`). It applies the exact `supabase/migrations/*.sql` files and speaks the slice of
 * the Supabase query-builder API the app's 23 repository modules use:
 *
 *   db().from(table).select().eq().in().order().limit().single().maybeSingle()
 *   db().from(table).insert()/.upsert()/.update()/.delete()  (each with .select().single())
 *   db().rpc(name, params)
 *
 * Because the local connection is the PGlite superuser, row-level security is bypassed cleanly (the hosted
 * model gates reads behind `private.is_server()`, which a local single-tenant database does not need).
 */
import { PGlite, type PGlite as PGliteType } from "@electric-sql/pglite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureBootstrap, serverSecretHash } from "./bootstrap";
import { pgDataDir, ensureDir, isLocalMode } from "./paths";

export interface QueryResult<T = unknown> {
  data: T | null;
  error: { message: string; code?: string; details?: string } | null;
  count?: number | null;
}

export interface DbError {
  message: string;
  code?: string;
}

type WhereOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in";

interface Condition {
  kind: "and" | "or" | "not";
  col?: string;
  op?: WhereOp;
  val?: unknown;
  children?: Condition[];
}

const MIGRATION_ROLES = ["anon", "authenticated", "service_role", "authenticator", "supabase_admin", "dashboard_user"];

interface LocalDbOptions {
  inMemory?: boolean;
  dataDir?: string;
  migrationsDir?: string;
}

const globalDb = globalThis as typeof globalThis & { __omLocalDb?: { pgInstance: PGliteType | null; migrationsApplied: boolean; clientSingleton: LocalDbClient | null; ready?: Promise<PGliteType> } };
const localState = globalDb.__omLocalDb ??= { pgInstance: null, migrationsApplied: false, clientSingleton: null };

function findMigrationsDir(override?: string): string | null {
  const dir = override || process.env.OPENMAN_MIGRATIONS_DIR || join(process.cwd(), "supabase", "migrations");
  return existsSync(/* turbopackIgnore: true */ dir) ? dir : null;
}

/** The singleton embedded database, with migrations applied exactly once. */
export async function getLocalDb(options: LocalDbOptions = {}): Promise<PGliteType> {
  localState.ready ??= (async () => {
    ensureBootstrap();
    const dir = options.inMemory ? undefined : options.dataDir || pgDataDir();
    if (dir) ensureDir(dir);
    const pg = options.inMemory ? new PGlite() : new PGlite(dir);
    localState.pgInstance = pg;
    try { await applyMigrations(pg, options.migrationsDir); localState.migrationsApplied = true; return pg; }
    catch (error) { await pg.close(); localState.pgInstance = null; localState.ready = undefined; throw error; }
  })();
  return localState.ready;
}

async function applyMigrations(pg: PGliteType, migrationsDir?: string): Promise<void> {
  // Roles the migrations grant to (anon/authenticated/...). They do not exist in a bare PGlite.
  for (const role of MIGRATION_ROLES) {
    try {
      await pg.exec(`create role ${role} nologin;`);
    } catch {
      // already exists
    }
  }
  await pg.exec(`create table if not exists _om_migrations (name text primary key, applied_at timestamptz not null default now());`);
  const dir = findMigrationsDir(migrationsDir);
  if (!dir) {
    throw new Error("Local database migrations are missing from the application bundle.");
  }
  const files = readdirSync(/* turbopackIgnore: true */ dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const applied = await pg.query<{ name: string }>(`select name from _om_migrations where name = $1`, [file]);
    if (applied.rows.length > 0) continue;
    const sql = readFileSync(/* turbopackIgnore: true */ join(dir, file), "utf8");
    await pg.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`insert into _om_migrations (name) values ($1)`, [file]);
    });
  }
  // Seed the server secret so the schema is byte-for-byte compatible with the hosted model.
  const hash = serverSecretHash();
  await pg.exec(`insert into private.server_secret (sha256_hex) values ('${hash}') on conflict (id) do update set sha256_hex = excluded.sha256_hex, set_at = now();`).catch(() => {});
}

/* ---------------------------------------------------------------- builder */

class LocalQueryBuilder {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private table = "";
  private schema = "public";
  private columns = "*";
  private returning = false;
  private values: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private updateValues: Record<string, unknown> | null = null;
  private where: Condition[] = [];
  private orderBy: { col: string; desc: boolean }[] = [];
  private limitVal: number | null = null;
  private offsetVal = 0;
  private singleMode: "single" | "maybeSingle" | null = null;
  private countFlag = false;
  private onConflict: string | null = null;
  private pg: PGliteType;

  constructor(pg: PGliteType, table: string) {
    this.pg = pg;
    this.table = table;
  }

  schema_(name: string): this {
    this.schema = name;
    return this;
  }

  select(columns = "*"): this {
    if (this.op === "select" || this.op === undefined) {
      this.op = "select";
      this.columns = columns;
    } else {
      this.returning = true;
    }
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = "insert";
    this.values = values;
    return this;
  }

  upsert(values: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }): this {
    this.op = "insert";
    this.values = values;
    this.onConflict = opts?.onConflict ?? "__primary_key__";
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.op = "update";
    this.updateValues = values;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  private addCond(cond: Condition): this {
    this.where.push(cond);
    return this;
  }

  eq(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "eq", val });
  }
  neq(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "neq", val });
  }
  gt(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "gt", val });
  }
  gte(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "gte", val });
  }
  lt(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "lt", val });
  }
  lte(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "lte", val });
  }
  like(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "like", val });
  }
  ilike(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "ilike", val });
  }
  is(col: string, val: unknown): this {
    return this.addCond({ kind: "and", col, op: "is", val });
  }
  in(col: string, vals: unknown[]): this {
    return this.addCond({ kind: "and", col, op: "in", val: vals });
  }
  not(col: string, op: WhereOp, val: unknown): this {
    return this.addCond({ kind: "not", col, op, val });
  }
  or(conditions: string): this {
    // Limited Supabase-style `or`: comma-separated `col.op.val`, OR-ed together.
    const children = conditions
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => parseOrPart(part))
      .filter((c): c is Condition => c !== null);
    if (children.length > 0) this.addCond({ kind: "or", children });
    return this;
  }
  match(obj: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(obj)) this.eq(k, v);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy.push({ col, desc: !(opts?.ascending ?? true) });
    return this;
  }
  limit(n: number): this {
    this.limitVal = n;
    return this;
  }
  range(from: number, to: number): this {
    this.offsetVal = from;
    this.limitVal = Math.max(0, to - from + 1);
    return this;
  }
  single(): this {
    this.singleMode = "single";
    return this;
  }
  maybeSingle(): this {
    this.singleMode = "maybeSingle";
    return this;
  }
  // Supabase exposes a `count` option on select; mirror it.
  selectCount(): this {
    this.countFlag = true;
    return this;
  }

  private whereSQL(params: unknown[]): string {
    if (this.where.length === 0) return "";
    const clauses = this.where.map((c) => this.condSQL(c, params));
    return ` where ${clauses.join(" and ")}`;
  }

  private condSQL(c: Condition, params: unknown[]): string {
    if (c.kind === "or" && c.children) {
      return `(${c.children.map((ch) => this.condSQL(ch, params)).join(" or ")})`;
    }
    if (c.kind === "not" && c.col && c.op && c.val !== undefined) {
      return `(not (${this.leafSQL(c.col, c.op, c.val, params)}))`;
    }
    if (c.kind === "and" && c.col && c.op && c.val !== undefined) {
      return this.leafSQL(c.col, c.op, c.val, params);
    }
    return "true";
  }

  private leafSQL(col: string, op: WhereOp, val: unknown, params: unknown[]): string {
    const safeCol = `${quoteIdent(col)}`;
    if (op === "is") {
      if (val === null) return `${safeCol} is null`;
      if (val === true) return `${safeCol} is true`;
      if (val === false) return `${safeCol} is false`;
      return `${safeCol} is null`;
    }
    if (op === "in") {
      params.push(val);
      return `${safeCol} = any($${params.length})`;
    }
    params.push(val);
    const sym = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" }[op];
    return `${safeCol} ${sym} $${params.length}`;
  }

  private async run(): Promise<QueryResult> {
    const params: unknown[] = [];
    const tableSql = `${quoteIdent(this.schema)}.${quoteIdent(this.table)}`;
    try {
      if (this.op === "select") {
        const cols = this.columns === "*" ? "*" : this.columns;
        const where = this.whereSQL(params);
        const order = this.orderBy.length ? ` order by ${this.orderBy.map((o) => `${quoteIdent(o.col)} ${o.desc ? "desc" : "asc"}`).join(", ")}` : "";
        const limit = this.limitVal != null ? ` limit ${Math.max(0, Math.trunc(this.limitVal))}` : "";
        const offset = this.offsetVal > 0 ? ` offset ${Math.trunc(this.offsetVal)}` : "";
        const sql = `select ${cols} from ${tableSql}${where}${order}${limit}${offset}`;
        const res = await this.pg.query(sql, params);
        const rows = res.rows;
        if (this.singleMode === "single") {
          if (rows.length === 0) return { data: null, error: { message: "Exactly one row was expected but none were found.", code: "PGRST116" } };
          if (rows.length > 1) return { data: null, error: { message: "Exactly one row was expected but multiple were found.", code: "PGRST116" } };
        }
        if (this.singleMode === "maybeSingle" && rows.length === 0) return { data: null, error: null };
        const data = this.singleMode ? (rows[0] ?? null) : rows;
        let count: number | null = null;
        if (this.countFlag) {
          const cRes = await this.pg.query<{ c: number }>(`select count(*)::int as c from ${tableSql}${where}`, params);
          count = cRes.rows[0]?.c ?? 0;
        }
        return { data, error: null, count };
      }

      if (this.op === "insert") {
        const rows = Array.isArray(this.values) ? this.values : [this.values];
        if (rows.length === 0) return { data: [], error: null };
        const cols = Object.keys(rows[0] ?? {});
        const valueRows = rows.map((r) => {
          const vals = cols.map((c) => {
            params.push((r as Record<string, unknown>)[c]);
            return `$${params.length}`;
          });
          return `(${vals.join(", ")})`;
        });
        if (this.onConflict === "__primary_key__") {
          const pk = await this.pg.query<{ name: string }>(`select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = $1::regclass and i.indisprimary order by a.attnum`, [`${this.schema}.${this.table}`]);
          this.onConflict = pk.rows.map((row) => quoteIdent(row.name)).join(", ");
        }
        const conflict = this.onConflict ? ` on conflict (${this.onConflict}) do update set ${cols.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(", ")}` : "";
        const sql = `insert into ${tableSql} (${cols.map(quoteIdent).join(", ")}) values ${valueRows.join(", ")}${conflict} returning *`;
        const res = await this.pg.query(sql, params);
        return this.wrapWrite(res.rows);
      }

      if (this.op === "update") {
        const setCols = Object.keys(this.updateValues ?? {});
        const sets = setCols.map((c) => {
          params.push((this.updateValues as Record<string, unknown>)[c]);
          return `${quoteIdent(c)} = $${params.length}`;
        });
        const where = this.whereSQL(params);
        const sql = `update ${tableSql} set ${sets.join(", ")}${where} returning *`;
        const res = await this.pg.query(sql, params);
        return this.wrapWrite(res.rows);
      }

      // delete
      const where = this.whereSQL(params);
      const sql = `delete from ${tableSql}${where} returning *`;
      const res = await this.pg.query(sql, params);
      return this.wrapWrite(res.rows);
    } catch (err) {
      return { data: null, error: normalizeError(err) };
    }
  }

  private wrapWrite(rows: unknown[]): QueryResult {
    if (this.singleMode === "single") {
      if (rows.length === 0) return { data: null, error: { message: "No rows affected.", code: "PGRST116" } };
      return { data: rows[0], error: null };
    }
    if (this.singleMode === "maybeSingle") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then<TResult = QueryResult>(onfulfilled?: (value: QueryResult) => TResult | PromiseLike<TResult>, onrejected?: (reason: unknown) => TResult | PromiseLike<TResult>): Promise<TResult> {
    return this.run().then(onfulfilled, onrejected);
  }

  catch(onrejected: (reason: unknown) => unknown): Promise<QueryResult> {
    return this.run().then(
      (v) => v,
      (e) => {
        onrejected(e);
        return { data: null, error: normalizeError(e) };
      },
    );
  }
}

function parseOrPart(part: string): Condition | null {
  const m = part.match(/^(\w+)\.(\w+)\.(.+)$/);
  if (!m) return null;
  const [, , op, raw] = m;
  const val = raw === "null" ? null : raw.replace(/^'(.*)'$/, "$1");
  return { kind: "and", col: m[1], op: op as WhereOp, val };
}

function normalizeError(err: unknown): { message: string; code?: string; details?: string } {
  if (err && typeof err === "object" && "message" in err) {
    const e = err as { message?: string; code?: string; detail?: string };
    return { message: e.message || String(err), code: e.code, details: e.detail };
  }
  return { message: String(err) };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/* ---------------------------------------------------------------- client */

export class LocalDbClient {
  private pg: PGliteType;
  constructor(pg: PGliteType) {
    this.pg = pg;
  }
  from(table: string): LocalQueryBuilder {
    return new LocalQueryBuilder(this.pg, table);
  }
  schema(name: string): { from: (t: string) => LocalQueryBuilder } {
    return { from: (t: string) => new LocalQueryBuilder(this.pg, t).schema_(name) };
  }
  async rpc<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<QueryResult<T>> {
    try {
      const entries = Object.entries(params);
      const args = entries.map(([key], i) => `${quoteIdent(key)} => $${i + 1}`).join(", ");
      const res = await this.pg.query<Record<string, unknown>>(`select ${quoteIdent(name)}(${args}) as result`, entries.map(([, value]) => value));
      return { data: (res.rows[0]?.result as T) ?? null, error: null };
    } catch (err) {
      return { data: null, error: normalizeError(err) };
    }
  }
  /** Direct access for migrations/tests. */
  get pgClient(): PGliteType {
    return this.pg;
  }
}



/** A ready-to-use local DB client (applies migrations on first call). */
export async function getLocalDbClient(options?: LocalDbOptions): Promise<LocalDbClient> {
  const pg = await getLocalDb(options);
  if (!localState.clientSingleton) localState.clientSingleton = new LocalDbClient(pg);
  return localState.clientSingleton;
}

/** Synchronous accessor for an already-initialized client (returns null before `initLocalDb`). */
export function getLocalDbClientSync(): LocalDbClient | null {
  return localState.clientSingleton;
}

/** Idempotent startup initializer: applies migrations and stores the ready client. */
export async function initLocalDb(options?: LocalDbOptions): Promise<LocalDbClient> {
  return getLocalDbClient(options);
}

export function localModeEnabled(): boolean {
  return isLocalMode();
}
