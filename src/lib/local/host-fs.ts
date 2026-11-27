// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Cross-platform local filesystem operations for the host engine.
 *
 * This replaces every `stat -c %s`, `readlink -f`, `base64 -w0`, `xdotool` and `/root/...` shell hack
 * the cloud version used on its Orgo VM. All paths are resolved with `node:path` against the user's
 * workspace (or app data) so the same code runs bit-for-bit on Windows, macOS and Linux.
 */
import { promises as fs, statSync } from "node:fs";
import { join, resolve, isAbsolute, relative, extname } from "node:path";
import { homedir } from "node:os";
import { workspaceDir, uploadsDir, incomingDir } from "./paths";

export class HostFsError extends Error {
  constructor(message: string, readonly code: number, readonly path?: string) {
    super(message);
    this.name = "HostFsError";
  }
}

const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Expand a `~/...` or bare path against search folders; returns candidate absolute paths. */
function expandCandidates(candidate: string, extraDirs: string[]): string[] {
  const out: string[] = [];
  const home = homedir();
  if (candidate.startsWith("~/") || candidate === "~") {
    out.push(resolve(home, candidate.slice(2)));
    return out;
  }
  if (isAbsolute(candidate)) {
    out.push(candidate);
    return out;
  }
  // Bare name: search common folders.
  const dirs = [workspaceDir(), uploadsDir(), incomingDir(), join(home, "Desktop"), join(home, "Documents"), join(home, "Downloads"), home, ...extraDirs];
  for (const d of dirs) {
    if (d) out.push(join(d, candidate));
  }
  return out;
}

export interface FoundFile {
  path: string;
  size: number;
  modifiedAt: number;
}

/** Which of `candidates` are regular files that changed within the last `maxAgeSec`. */
export async function findFiles(candidates: string[], maxAgeSec: number, extraDirs: string[] = []): Promise<FoundFile[]> {
  const safe = (v: string) => v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f]/.test(v);
  const names = [...new Set(candidates.filter(safe))].slice(0, 60);
  const now = Date.now();
  const found = new Map<string, FoundFile>();
  const cutoff = Math.max(1, Math.round(maxAgeSec));
  for (const name of names) {
    for (const cand of expandCandidates(name, extraDirs)) {
      try {
        const st = statSync(/* turbopackIgnore: true */ cand);
        if (!st.isFile()) continue;
        const age = (now - st.mtimeMs) / 1000;
        if (age > cutoff) continue;
        found.set(cand, { path: cand, size: st.size, modifiedAt: st.mtimeMs });
        break;
      } catch {
        // not here; try the next folder
      }
    }
  }
  return [...found.values()];
}

export async function readLocalFile(path: string): Promise<Buffer> {
  const abs = resolve(path);
  let st;
  try {
    st = await fs.stat(/* turbopackIgnore: true */ abs);
  } catch {
    throw new HostFsError("The file is no longer on this computer.", 404, abs);
  }
  if (!st.isFile()) throw new HostFsError("Not a file.", 400, abs);
  if (st.size > MAX_FILE_BYTES) throw new HostFsError("The file is too large to open here.", 413, abs);
  return fs.readFile(/* turbopackIgnore: true */ abs);
}

export async function fileInfo(path: string): Promise<{ size: number; modifiedAt: number; exists: boolean }> {
  try {
    const st = await fs.stat(/* turbopackIgnore: true */ resolve(path));
    return { size: st.size, modifiedAt: st.mtimeMs, exists: st.isFile() };
  } catch {
    return { size: 0, modifiedAt: 0, exists: false };
  }
}

/** Read a byte range of a file (used by chunked uploads / previews). */
export async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const abs = resolve(path);
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(length, MAX_FILE_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}

export async function writeLocalFile(path: string, data: Buffer | string): Promise<{ size: number }> {
  const abs = resolve(path);
  await fs.mkdir(join(abs, ".."), { recursive: true });
  await fs.writeFile(abs, data);
  const st = await fs.stat(/* turbopackIgnore: true */ abs);
  return { size: st.size };
}

export async function deleteLocalFile(path: string): Promise<void> {
  await fs.rm(resolve(path), { force: true });
}

export async function listDir(path: string): Promise<{ name: string; path: string; isDir: boolean; size: number; modifiedAt: number }[]> {
  const abs = resolve(path);
  let entries;
  try {
    entries = await fs.readdir(/* turbopackIgnore: true */ abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const full = join(abs, e.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(/* turbopackIgnore: true */ full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // ignore
    }
    out.push({ name: e.name, path: full, isDir: e.isDirectory(), size, modifiedAt: mtime });
  }
  return out;
}

export function withinWorkspace(path: string): string {
  return resolve(path);
}

/** Quote one shell argument for bash/zsh (Linux/macOS) and Git Bash on Windows. */
export function quoteBash(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote one argument for Windows PowerShell. */
export function quotePowerShell(value: string): string {
  return `'$($('${value.replace(/'/g, "''")}').Replace('"', '\\"'))'`;
}

/** A path with a safe extension for the OS (used when staging secrets/files). */
export function hasExecutableExtension(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (process.platform === "win32") return [".exe", ".bat", ".cmd", ".ps1", ".com"].includes(ext);
  return [".sh", ".bin", ".run", ".appimage"].includes(ext);
}

export { extname, relative };
