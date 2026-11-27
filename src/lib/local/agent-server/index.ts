// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Embedded Local Agent Server.
 *
 * A self-contained Node/TypeScript Hermes-compatible agent runtime that the Next.js server talks to over HTTP
 * (see `src/lib/agent/server/hermes.ts` and `relay.ts`). It implements the exact wire protocol the relay expects:
 *
 *   POST /v1/runs                                  -> 202 { run_id, status }
 *   GET  /v1/runs/{id}/events                       -> SSE (id: <seq>, data: {"event": ...}), Last-Event-ID reconnect
 *   POST /v1/runs/{id}/stop | /steer | /approval | /clarify
 *   GET  /v1/runs/{id}
 *   GET  /api/sessions/{id}/messages
 *   POST /api/sessions/{id}/fork
 *
 * The server runs entirely on 127.0.0.1 and executes tools directly on the laptop:
 *   - shell / terminal (cross-platform bash/zsh/PowerShell)
 *   - file (read/write/edit/list/search) on the workspace
 *   - web (search via DuckDuckGo, fetch via a safe client)
 *   - computer_use (screenshot/click/type — driven by the desktop app on a real display)
 *   - todo / clarify / skills / mcp
 *
 * Model providers: Ollama (127.0.0.1:11434/v1), LM Studio / vLLM / llama.cpp (127.0.0.1:1234/v1), and cloud
 * keys when the user configures them in Settings. Offline inference requires a running local model server.
 */
import { brand } from "@/config/brand";
import { browserTool } from "../browser";
import { mcpRequest } from "../mcp";
import { listCustomConnectors } from "@/lib/db/connectors";
import { captureFrame, desktopInput, foregroundTitle, type DesktopInput } from "../desktop";
import { readLocalModelConfig } from "@/lib/db/local-models";
import { localServiceToken } from "../auth";
import { safeFetch } from "@/lib/net/safe-fetch";
import { seal, open } from "@/lib/crypto";
import { ensureBootstrap } from "../bootstrap";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { workspaceDir, agentDataDir, agentServerUrl, isLocalMode } from "../paths";
import { readLocalFile, writeLocalFile, listDir } from "../host-fs";
import { LocalHostClient } from "../host-client";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunEvent {
  event: string;
  run_id?: string;
  timestamp?: number;
  seq?: number;
  [key: string]: unknown;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface Run {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  model: string;
  input: string;
  events: RunEvent[];
  emitter: EventEmitter;
  controller: AbortController;
  generation: number;
  pendingControls: { id: string; type: "approval" | "clarify"; question?: string }[];
  finalText: string;
  instructions?: string;
  readOnly?: boolean;
  steering?: string[];
  respond?: (value: string) => void;
}

const globalAgent = globalThis as typeof globalThis & { __omAgent?: { runs: Map<string, Run>; server: Server | null } };
const agentState = globalAgent.__omAgent ??= { runs: new Map<string, Run>(), server: null };
const runs = agentState.runs;
const idempotentRuns = new Map<string, string>();
type Message = { role: string; content: string; images?: { base64: string; mime: string }[]; tool_calls?: ToolCall[]; tool_call_id?: string };
function transcriptPath(sessionId: string): string { return join(agentDataDir(), `session-${createHash("sha256").update(sessionId).digest("hex")}.json`); }
function transcript(sessionId: string): Message[] {
  try { return JSON.parse(readFileSync(/* turbopackIgnore: true */ transcriptPath(sessionId), "utf8")) as Message[]; } catch { return []; }
}
function repairTranscript(messages: Message[]): Message[] {
  const output = [...messages];
  // A stopped run can leave an assistant tool batch partly unanswered. Keep provider
  // message ordering valid on the next turn without pretending those actions completed.
  let last = -1;
  for (let i = 0; i < output.length; i++) if (output[i].role === "assistant") last = i;
  if (last >= 0) {
    const answered = new Set(output.slice(last + 1).map(message => message.tool_call_id));
    for (const tool of output[last].tool_calls || []) if (!answered.has(tool.id)) output.push({ role: "tool", tool_call_id: tool.id, content: "The prior run stopped before this tool returned. Its outcome is unknown; inspect state before retrying." });
  }
  return output;
}
function saveTranscript(sessionId: string, messages: Message[]): void {
  writeFileSync(transcriptPath(sessionId), JSON.stringify(messages), { mode: 0o600 });
}

/* ---------------------------------------------------------------- model config */

export interface ModelConfig {
  provider: "ollama" | "lmstudio" | "openai" | "anthropic" | "gemini" | "openrouter" | "none";
  baseUrl?: string;
  apiKey?: string;
  model: string;
  modeModels?: Partial<Record<"lite" | "standard" | "max" | "flex", string>>;
}

export function agentConfigPath(): string {
  return join(agentDataDir(), "agent-config.json");
}

export function loadModelConfig(): ModelConfig {
  const path = agentConfigPath();
  if (existsSync(/* turbopackIgnore: true */ path)) {
    try {
      ensureBootstrap();
      const stored = readFileSync(/* turbopackIgnore: true */ path, "utf8");
      const raw = JSON.parse(stored.startsWith("v1.") ? open(stored) : stored) as Partial<ModelConfig>;
      if (raw.provider && raw.model) return raw as ModelConfig;
    } catch {
      // fall through
    }
  }
  const providers = [ ["anthropic", "ANTHROPIC_API_KEY", "claude-sonnet-4-6"], ["openai", "OPENAI_API_KEY", "gpt-4.1"], ["gemini", "GEMINI_API_KEY", "gemini-2.5-flash"], ["openrouter", "OPENROUTER_API_KEY", "openai/gpt-4.1"] ] as const;
  for (const [provider, key, model] of providers) if (process.env[key]) return { provider, apiKey: process.env[key], model: process.env.OPENMAN_MODEL || model };
  return { provider: "none", model: "local" };
}

export function saveModelConfig(cfg: ModelConfig): void {
  mkdirSync(agentDataDir(), { recursive: true });
  ensureBootstrap();
  writeFileSync(agentConfigPath(), seal(JSON.stringify(cfg)), { mode: 0o600 });
}

/* ---------------------------------------------------------------- event helpers */

function emit(run: Run, event: string, data: Record<string, unknown>): void {
  const seq = run.events.length + 1;
  const ev: RunEvent = { event, run_id: run.id, timestamp: Date.now(), seq, ...data };
  run.events.push(ev);
  run.emitter.emit("event", ev);
}

/* ---------------------------------------------------------------- tools */

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
  image?: { base64: string; mime: string };
}

const TOOL_DEFS = [
  { name: "shell", description: "Run a shell command on this computer (bash/zsh/PowerShell).", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } },
  { name: "file_read", description: "Read a file from the workspace by absolute or relative path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "file_write", description: "Write content to a file in the workspace.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "file_edit", description: "Replace occurrences of `old` with `new` in a file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
  { name: "list_dir", description: "List a directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_files", description: "Search files for literal text (case insensitive, bounded recursive search).", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "web_search", description: "Search the web and return a few results.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "web_fetch", description: "Fetch a URL and return its text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "omtools", description: "Read referenced tasks, manage automations, or create parallel subtasks. Use the tool name and arguments from the task instructions.", parameters: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool"] } },
  { name: "skills", description: "List installed skills or read a named skill's instructions.", parameters: { type: "object", properties: { name: { type: "string" } } } },
  { name: "custom_api", description: "Call a configured custom API. Its saved key is added automatically.", parameters: { type: "object", properties: { server: { type: "string" }, path: { type: "string" }, method: { type: "string" }, body: { type: "string" } }, required: ["server", "path"] } },
  { name: "mcp", description: "List or call tools from a configured MCP connector. Omit tool to list.", parameters: { type: "object", properties: { server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, required: ["server"] } },
  { name: "browser", description: "Use the isolated native browser profile. Read a page or interact with CSS selectors after permission.", parameters: { type: "object", properties: { action: { type: "string", enum: ["navigate", "click", "type", "press", "tabs", "read", "close"] }, url: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, key: { type: "string" }, tab: { type: "number" } }, required: ["action"] } },
  { name: "computer_use", description: "Use the local desktop. Requires app permission.", parameters: { type: "object", properties: { action: { type: "string", enum: ["click", "move", "scroll", "type_text", "press_key"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" }, delta: { type: "number" } }, required: ["action"] } },
  { name: "screenshot", description: "Capture the current screen (when a display is available).", parameters: { type: "object", properties: {} } },
  { name: "todo", description: "Update the task todo list.", parameters: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] } }, required: ["content", "status"] } } }, required: ["items"] } },
  { name: "clarify", description: "Ask the user a clarifying question.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
];

async function runTool(call: ToolCall, run?: Run): Promise<ToolResult> {
  try {
    run?.controller.signal.throwIfAborted();
    switch (call.name) {
      case "shell": {
        const host = new LocalHostClient();
        const r = await host.bash("local-host", String(call.arguments.command ?? ""), Number(call.arguments.timeout ?? 60), run?.controller.signal);
        return { ok: r.success, output: r.output, data: { exitCode: r.exit_code } };
      }
      case "file_read": {
        const buf = await readLocalFile(resolveWorkspace(String(call.arguments.path)));
        return { ok: true, output: buf.toString("utf8") };
      }
      case "file_write": {
        const res = await writeLocalFile(resolveWorkspace(String(call.arguments.path)), String(call.arguments.content ?? ""));
        return { ok: true, output: `Wrote ${res.size} bytes to ${call.arguments.path}` };
      }
      case "file_edit": {
        const p = resolveWorkspace(String(call.arguments.path));
        const buf = await readLocalFile(p);
        const text = buf.toString("utf8").split(String(call.arguments.old)).join(String(call.arguments.new));
        await writeLocalFile(p, text);
        return { ok: true, output: `Edited ${call.arguments.path}` };
      }
      case "list_dir": {
        const items = await listDir(resolveWorkspace(String(call.arguments.path)));
        return { ok: true, output: items.map((i) => `${i.isDir ? "d" : "-"} ${i.name}`).join("\n"), data: items };
      }
      case "search_files": {
        const out = await grep(String(call.arguments.pattern), resolveWorkspace(String(call.arguments.path ?? ".")));
        return { ok: true, output: out };
      }
      case "web_search": {
        const results = await webSearch(String(call.arguments.query));
        return { ok: true, output: results };
      }
      case "web_fetch": {
        const text = await webFetch(String(call.arguments.url));
        return { ok: true, output: text.slice(0, 8000) };
      }
      case "screenshot": {
        const path = join(workspaceDir(), `screenshot-${randomUUID()}.png`); const image = await captureFrame(); await writeLocalFile(path, image);
        return { ok: true, output: `Screenshot saved to ${path}`, data: { path }, image: { base64: image.toString("base64"), mime: "image/png" } };
      }
      case "browser": return { ok: true, output: await browserTool(call.arguments) };
      case "computer_use": { await desktopInput(call.arguments as unknown as DesktopInput); return { ok: true, output: "Desktop input sent" }; }
      case "skills": {
        const { listSkills, readSkill } = await import("@/lib/skills"); const { localSession } = await import("@/lib/session/local");
        const data = typeof call.arguments.name === "string" ? await readSkill(localSession(), call.arguments.name) : await listSkills(localSession());
        return { ok: true, output: JSON.stringify(data) };
      }
      case "omtools": {
        if (!run) throw new Error("This tool requires a task run");
        const { runAgentTool } = await import("@/lib/agent/server/agent-tools");
        const { DbStore } = await import("@/lib/store/db-store");
        const result = await runAgentTool({ store: new DbStore("local-user"), taskId: run.sessionId.match(/^openman-([A-Za-z0-9]{22})-/)?.[1] || run.sessionId, askApproval: async (title, detail) => (await waitForControl(run, "approval", { title, description: detail, choices: ["once", "deny"] })) === "once" }, String(call.arguments.tool), (call.arguments.arguments ?? {}) as Record<string, unknown>);
        return { ok: !result.error, output: result.text };
      }
      case "custom_api": {
        const connectors = await listCustomConnectors("local-user"); const connector = connectors.find((item) => item.serverName === call.arguments.server || item.name === call.arguments.server);
        if (!connector || connector.kind !== "api" || !connector.url) throw new Error("Unknown custom API");
        const base = new URL(connector.url); const target = new URL(String(call.arguments.path), base);
        if (target.origin !== base.origin) throw new Error("The API request must stay on its configured origin");
        const response = await safeFetch(target, { method: String(call.arguments.method || "GET"), headers: connector.secretEnc ? { [connector.authHeader || "Authorization"]: open(connector.secretEnc) } : {}, body: typeof call.arguments.body === "string" ? call.arguments.body : undefined, maxRedirects: 0 });
        return { ok: response.ok, output: (await response.text()).slice(0, 20000) };
      }
      case "mcp": {
        const connectors = await listCustomConnectors("local-user"); const connector = connectors.find((item) => item.serverName === call.arguments.server || item.name === call.arguments.server);
        if (!connector || connector.kind !== "mcp") throw new Error("Unknown MCP connector. Configure it in Settings → Connectors.");
        const tool = call.arguments.tool;
        const result = await mcpRequest(connector, typeof tool === "string" ? "tools/call" : "tools/list", typeof tool === "string" ? { name: tool, arguments: call.arguments.arguments ?? {} } : {});
        return { ok: true, output: JSON.stringify(result) };
      }
      case "todo": {
        return { ok: true, output: JSON.stringify({ todos: call.arguments.items }) };
      }
      case "clarify": {
        return { ok: true, output: String(call.arguments.question ?? "") };
      }
      default:
        return { ok: false, output: `Unknown tool: ${call.name}` };
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function resolveWorkspace(p: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return join(workspaceDir(), p.replace(/^~\//, ""));
}

async function grep(pattern: string, root: string): Promise<string> {
  // Literal matching cannot turn a read-only tool into shell execution or an unbounded regular expression.
  const { readdir, readFile, lstat } = await import("node:fs/promises");
  const hits: string[] = [], queue = [root];
  const needle = pattern.slice(0, 2000).toLocaleLowerCase();
  let visited = 0;
  const deadline = Date.now() + 5000;
  while (queue.length && hits.length < 100 && visited < 10000 && Date.now() < deadline) {
    const path = queue.shift()!; visited++;
    try {
      const info = await lstat(/* turbopackIgnore: true */ path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        for (const entry of await readdir(/* turbopackIgnore: true */ path, { withFileTypes: true })) {
          if (!entry.name.startsWith(".") && !["node_modules", "__pycache__"].includes(entry.name)) queue.push(join(path, entry.name));
          if (queue.length > 10000) break;
        }
      } else if (info.isFile() && info.size <= 1000000) {
        const data = await readFile(/* turbopackIgnore: true */ path);
        if (data.includes(0)) continue;
        for (const [index, line] of data.toString("utf8").split("\n").entries()) {
          if (line.toLocaleLowerCase().includes(needle)) hits.push(`${path}:${index + 1}: ${line.slice(0, 1000)}`);
          if (hits.length >= 100) break;
        }
      }
    } catch { /* unreadable files do not fail the entire search */ }
  }
  return hits.join("\n") || "(no matches)";
}

async function webSearch(query: string): Promise<string> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": `${brand.name}/1.0` } });
    const html = await res.text();
    const titles = [...html.matchAll(/result__a[^>]*>([^<]+)</g)].slice(0, 5).map((m) => m[1].trim());
    const links = [...html.matchAll(/result__a[^>]*href="([^"]+)"/g)].slice(0, 5).map((m) => m[1]);
    return titles.map((t, i) => `${i + 1}. ${t} — ${links[i] ?? ""}`).join("\n") || "No results.";
  } catch {
    return "(web search unavailable offline)";
  }
}

/** A safe fetch: refuses private/loopback/link-local addresses to avoid SSRF (user URLs only). */
async function webFetch(url: string): Promise<string> {
  const res = await safeFetch(url, { timeoutMs: 15_000 });
  return (await res.text()).replace(/<[^>]+>/g, " ").slice(0, 8000);
}

/* ---------------------------------------------------------------- run loop */

async function waitForControl(run: Run, kind: "approval" | "clarify", fields: Record<string, unknown>): Promise<string> {
  run.controller.signal.throwIfAborted();
  const id = randomUUID();
  run.pendingControls.push({ id, type: kind });
  return new Promise((resolve, reject) => {
    const abort = () => { run.respond = undefined; run.pendingControls = []; reject(new Error("Run stopped")); };
    run.controller.signal.addEventListener("abort", abort, { once: true });
    run.respond = (answer) => {
      run.controller.signal.removeEventListener("abort", abort);
      run.pendingControls = []; run.respond = undefined;
      emit(run, `${kind}.settled`, { request_id: id }); resolve(answer);
    };
    emit(run, `${kind}.request`, { request_id: id, execution_generation: run.generation, ...fields });
  });
}

async function executeRun(run: Run): Promise<void> {
  try {
    const cfg = (await readLocalModelConfig()) ?? loadModelConfig();
    if (Object.values(cfg.modeModels ?? {}).includes(run.model)) cfg.model = run.model;
    emit(run, "run.started", { session_id: run.sessionId });
    emit(run, "message", { role: "user", content: run.input });

    if (cfg.provider === "none") throw new Error("No model configured. Open Settings → AI Models & Providers and select Ollama, LM Studio, or an API provider.");

    // LLM-backed loop with tools.
    const messages: Message[] = [...(run.instructions ? [{ role: "system", content: run.instructions }] : []), ...repairTranscript(transcript(run.sessionId)).filter((message) => message.role !== "system"), { role: "user", content: run.input }];
    let completed = false;
    for (let step = 0; step < 24 && !completed; step++) {
      run.controller.signal.throwIfAborted();
      for (const text of run.steering?.splice(0) ?? []) messages.push({ role: "user", content: text });
      const reply = await callLLM(cfg, messages, run.controller.signal);
      messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });
      saveTranscript(run.sessionId, messages);
      if (reply.content) {
        emit(run, "message.delta", { delta: reply.content });
        run.finalText += reply.content;
      }
      if (reply.toolCalls.length === 0) {
        completed = true;
        break;
      }
      const images: NonNullable<Message["images"]> = [];
      for (const tc of reply.toolCalls) {
        run.controller.signal.throwIfAborted();
        if (tc.name === "computer_use" || tc.name === "screenshot") tc.arguments.app = await foregroundTitle().catch(() => "Desktop");
        emit(run, "tool.started", { tool: tc.name, tool_call_id: tc.id, preview: JSON.stringify(tc.arguments).slice(0, 2000), input: tc.arguments });
        let res: ToolResult;
        if (run.readOnly && !["file_read", "list_dir", "search_files", "web_search", "web_fetch", "skills", "todo", "clarify"].includes(tc.name)) {
          res = { ok: false, output: "This mode is read-only. Switch to Agent mode to take actions." };
        } else if (tc.name === "shell") {
          const choice = await waitForControl(run, "approval", { command: String(tc.arguments.command ?? ""), description: "Allow this command on your computer?", choices: ["once", "deny"] });
          res = choice === "once" ? await runTool(tc, run) : { ok: false, output: "User denied command execution." };
        } else if (tc.name === "browser") {
          const choice = await waitForControl(run, "approval", { description: `Allow browser action: ${String(tc.arguments.action)}?`, choices: ["once", "deny"] });
          res = choice === "once" ? await runTool(tc, run) : { ok: false, output: "User denied browser access." };
        } else if (tc.name === "computer_use" || tc.name === "screenshot") {
          const app = await foregroundTitle().catch(() => "Desktop");
          const choice = await waitForControl(run, "approval", { pattern_key: "computer_use:input", description: `Allow access to ${app}?`, choices: ["once", "deny"] });
          res = choice === "once" ? await runTool(tc, run) : { ok: false, output: "User denied desktop access." };
        } else if (tc.name === "clarify") {
          res = { ok: true, output: await waitForControl(run, "clarify", { question: String(tc.arguments.question ?? "") }) };
        } else res = await runTool(tc, run);
        if (res.image) images.push(res.image);
        messages.push({ role: "tool", content: res.output, tool_call_id: tc.id });
        saveTranscript(run.sessionId, messages);
        emit(run, "tool.completed", { tool: tc.name, tool_call_id: tc.id, preview: res.output, output: res.output, ok: res.ok, error: !res.ok });
      }
      if (images.length) messages.push({ role: "user", content: "Screenshot from the approved desktop capture:", images });
    }
    run.controller.signal.throwIfAborted();
    if (!completed) throw new Error("The agent reached its step limit. Continue the task to proceed.");
    saveTranscript(run.sessionId, messages);
    run.status = "completed";
    emit(run, "run.completed", { output: run.finalText, usage: { input_tokens: 0, output_tokens: 0 } });
  } catch (err) {
    if (run.controller.signal.aborted) {
      run.status = "cancelled";
      emit(run, "run.cancelled", {});
    } else {
      run.status = "failed";
      emit(run, "run.failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

interface LLMReply {
  content: string;
  toolCalls: ToolCall[];
}

/** Call the configured model with the OpenAI-style tools protocol (Ollama, LM Studio, OpenAI, OpenRouter). */
async function callLLM(cfg: ModelConfig, messages: Message[], signal: AbortSignal): Promise<LLMReply> {
  const baseUrl = cfg.baseUrl || ({ ollama: "http://127.0.0.1:11434/v1", lmstudio: "http://127.0.0.1:1234/v1", openrouter: "https://openrouter.ai/api/v1", gemini: "https://generativelanguage.googleapis.com/v1beta/openai", anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1", none: "" }[cfg.provider]);
  if (cfg.provider === "anthropic") {
    const anthropicMessages = messages.filter((message) => message.role !== "system").map((message) => message.role === "tool"
      ? { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }] }
      : { role: message.role, content: [ ...(message.content ? [{ type: "text", text: message.content }] : []), ...(message.images ?? []).map(image => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } })), ...(message.tool_calls ?? []).map((tool) => ({ type: "tool_use", id: tool.id, name: tool.name, input: tool.arguments })) ] });
    const res = await fetch(`${baseUrl}/messages`, { method: "POST", signal, headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey || process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: cfg.model, system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"), max_tokens: 8192, messages: anthropicMessages, tools: TOOL_DEFS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }) });
    if (!res.ok) throw new Error(`Anthropic returned HTTP ${res.status}`);
    const data = await res.json() as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] };
    return { content: data.content.filter((item) => item.type === "text").map((item) => item.text).join(""), toolCalls: data.content.filter((item) => item.type === "tool_use").map((item) => ({ id: item.id!, name: item.name!, arguments: item.input ?? {} })) };
  }
  const body = {
    model: cfg.model,
    messages: messages.map((m) => ({ role: m.role, content: m.images?.length ? [{ type: "text", text: m.content }, ...m.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }))] : m.content, ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}) })),
    tools: TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: "auto",
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`Model provider returned HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error("Model provider returned no assistant message");
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: safeParseArgs(tc.function.arguments) }));
  return { content: msg?.content ?? "", toolCalls };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- HTTP server */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1024 * 1024) { reject(new Error("Request body too large")); req.destroy(); } });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export interface StartAgentServerOptions {
  port?: number;
  host?: string;
}

export async function startAgentServer(opts: StartAgentServerOptions = {}): Promise<Server> {
  if (agentState.server) return agentState.server;
  const port = opts.port ?? Number(process.env.OPENMAN_AGENT_PORT || "8642");
  const host = opts.host ?? "127.0.0.1";
  mkdirSync(agentDataDir(), { recursive: true });

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname.replace(/^\/p\/[^/]+/, "");
    const method = (req.method ?? "GET").toUpperCase();

    if (req.headers.origin || req.headers.authorization !== `Bearer ${localServiceToken()}`) {
      return sendJson(res, 403, { error: "Internal service authentication required" });
    }

    try {
      if (method === "POST" && path === "/v1/runs") {
        const body = (await readBody(req)) as { input?: string; session_id?: string; model?: string; instructions?: string };
        const key = req.headers["idempotency-key"];
        if (typeof key === "string" && idempotentRuns.has(key)) { const old = runs.get(idempotentRuns.get(key)!); if (old) return sendJson(res, 202, { run_id: old.id, status: old.status }); }
        const run = createRun(body.input ?? "", body.session_id ?? randomUUID(), body.model ?? "local");
        run.instructions = (typeof body.instructions === "string" ? body.instructions + "\n\n" : "") + "Use the native tool names in the supplied schema: todo (not todo_list), skills (not skill_view), and omtools with tool and arguments for app actions. Save deliverables inside the workspace.";
        run.readOnly = req.url?.startsWith("/p/om-chat/") || /(?:CHAT MODE|PLAN MODE|read-only mode)/i.test(run.instructions ?? "");
        if (typeof key === "string") idempotentRuns.set(key, run.id);
        sendJson(res, 202, { run_id: run.id, status: "running" });
        void executeRun(run);
        return;
      }

      const runMatch = path.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (method === "GET" && runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) {
          sendJson(res, 404, { error: "run not found" });
          return;
        }
        streamSSE(res, req, run);
        return;
      }

      const runGet = path.match(/^\/v1\/runs\/([^/]+)$/);
      if (method === "GET" && runGet) {
        const run = runs.get(runGet[1]);
        if (!run) return sendJson(res, 404, { error: "run not found" });
        return sendJson(res, 200, { run_id: run.id, status: run.status, session_id: run.sessionId, output: run.finalText, execution_generation: run.generation, pending_controls: run.pendingControls });
      }

      const controlMatch = path.match(/^\/v1\/runs\/([^/]+)\/(stop|steer|approval|clarify)$/);
      if (method === "POST" && controlMatch) {
        const run = runs.get(controlMatch[1]);
        if (!run) return sendJson(res, 404, { error: "run not found" });
        const kind = controlMatch[2];
        const body = (await readBody(req)) as { text?: string; choice?: string; answer?: string; request_id?: string; execution_generation?: number };
        if (kind === "stop") run.controller.abort();
        if (kind === "steer") (run.steering ??= []).push(body.text ?? "");
        if (kind === "approval" || kind === "clarify") {
          if (body.execution_generation !== undefined && body.execution_generation !== run.generation) return sendJson(res, 409, { error: "Stale execution generation" });
          if (!run.pendingControls.some((control) => control.id === body.request_id && control.type === kind)) return sendJson(res, 409, { error: "Control is no longer pending" });
          run.respond?.(kind === "approval" ? body.choice ?? "deny" : body.answer ?? "");
        }
        return sendJson(res, 200, { ok: true });
      }

      const msgMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (method === "GET" && msgMatch) {
        const messages = transcript(decodeURIComponent(msgMatch[1])).map((message, index) => ({ ...message, id: `message-${index}`, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool) => ({ id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) } : {}) }));
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
        const data = url.searchParams.get("order") === "latest" ? messages.slice(-limit).reverse() : messages.slice(-limit);
        return sendJson(res, 200, { data, messages: data });
      }
      const forkMatch = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
      if (method === "POST" && forkMatch) {
        const id = randomUUID(); saveTranscript(id, transcript(forkMatch[1]));
        return sendJson(res, 200, { session_id: id, forked: true });
      }

      if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, local: true });
      sendJson(res, 404, { error: "not found", path });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(port, host, resolve); });
  agentState.server = httpServer;
  console.log(`[local-agent] listening on http://${host}:${port}`);
  return httpServer;
}

function createRun(input: string, sessionId: string, model: string): Run {
  const id = `run_${randomUUID()}`;
  for (const [id, old] of runs) { if (runs.size < 200) break; if (old.status !== "running") { runs.delete(id); for (const [key, value] of idempotentRuns) if (value === id) idempotentRuns.delete(key); } }
  const run: Run = {
    id,
    sessionId,
    status: "running",
    model,
    input,
    events: [],
    emitter: new EventEmitter(),
    controller: new AbortController(),
    generation: 1,
    pendingControls: [],
    finalText: "",
  };
  run.emitter.setMaxListeners(100);
  runs.set(id, run);
  return run;
}

function streamSSE(res: ServerResponse, req: IncomingMessage, run: Run): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
  const lastId = Number(req.headers["last-event-id"] ?? "0");
  let seq = lastId;
  const send = (ev: RunEvent) => {
    if ((ev.seq ?? 0) <= lastId) return;
    res.write(`id: ${ev.seq}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // Replay missed events.
  for (const ev of run.events) send(ev);
  if (run.status !== "running") { res.end(); return; }
  const onEvent = (ev: RunEvent) => {
    seq = ev.seq ?? seq + 1;
    send(ev);
    if (["run.completed", "run.failed", "run.cancelled"].includes(ev.event)) { cleanup(); res.end(); }
  };
  run.emitter.on("event", onEvent);
  const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
  const cleanup = () => {
    clearInterval(ping);
    run.emitter.off("event", onEvent);
  };
  req.on("close", cleanup);
  run.controller.signal.addEventListener("abort", () => {
    cleanup();
    try {
      res.end();
    } catch {
      // ignore
    }
  });
  res.on("close", cleanup);
}

export function stopAgentServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!agentState.server) return resolve();
    for (const run of runs.values()) if (run.status === "running") run.controller.abort();
    agentState.server.closeAllConnections();
    agentState.server.close(() => resolve());
    agentState.server = null;
  });
}

export { agentServerUrl, isLocalMode };
