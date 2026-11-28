import { spawn } from "node:child_process";
import { safeFetch, checkUrl } from "@/lib/net/safe-fetch";
import { hostEnvironment } from "./process";
import type { CustomConnectorRecord } from "@/lib/db/connectors";
import { open } from "@/lib/crypto";

type Rpc = { id?: number; result?: unknown; error?: { message?: string } };
export async function mcpRequest(connector: CustomConnectorRecord, method: "tools/list" | "tools/call", params: Record<string, unknown> = {}): Promise<unknown> {
  const headers = connector.secretEnc ? JSON.parse(open(connector.secretEnc)) as Record<string, string> : {};
  if (connector.transport !== "command") {
    if (!connector.url) throw new Error("MCP server has no URL");
    const url = new URL(connector.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    await checkUrl(url, { allowLocalLoopback: loopback });
    if (!["http:", "https:"].includes(url.protocol) || (!loopback && url.protocol !== "https:")) throw new Error("MCP needs HTTPS or an explicit loopback HTTP endpoint");
    let sessionId: string | undefined;
    let protocol = "2025-03-26";
    const request = async (rpcMethod: string, rpcParams: unknown, id?: number) => {
      const response = await safeFetch(url.href, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": protocol, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: rpcMethod, params: rpcParams }), timeoutMs: 60000, maxRedirects: 0, allowLocalLoopback: loopback });
      if (!response.ok) throw new Error(`MCP returned HTTP ${response.status}`);
      sessionId = response.headers.get("mcp-session-id") || sessionId;
      if (id === undefined) return undefined;
      const text = await response.text();
      const candidates = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.replace(/\r\n/g, "\n").split("\n\n").map(block => block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean)
        : [text];
      for (const candidate of candidates) {
        let parsed: Rpc;
        try { parsed = JSON.parse(candidate) as Rpc; } catch { continue; }
        if (parsed.id !== id) continue;
        if (parsed.error) throw new Error(parsed.error.message || "MCP request failed");
        return parsed.result;
      }
      throw new Error("MCP returned no matching JSON-RPC response");
    };
    try {
      const init = await request("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "local-desktop", version: "1.0" } }, 1) as { protocolVersion?: string };
      protocol = init?.protocolVersion || protocol;
      await request("notifications/initialized", {});
      return await request(method, params, 2);
    } finally {
      if (sessionId) await safeFetch(url.href, { method: "DELETE", headers: { ...headers, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": protocol }, timeoutMs: 3000, maxRedirects: 0, allowLocalLoopback: loopback }).catch(() => undefined);
    }
  }
  if (!connector.command) throw new Error("MCP server has no command");
  return new Promise((resolve, reject) => {
    const child = spawn(connector.command!, connector.args ?? [], { env: { ...hostEnvironment(), ...headers }, stdio: "pipe", windowsHide: true });
    let buffer = "", settled = false;
    const timer = setTimeout(() => finish(new Error("MCP request timed out")), 60000);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); child.stdin.end(); child.kill("SIGKILL");
      if (error) reject(error); else resolve(value);
    };
    const send = (rpcMethod: string, rpcParams: unknown, id?: number) => {
      if (!settled) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: rpcMethod, params: rpcParams }) + "\n");
    };
    child.stdin.on("error", error => finish(error));
    child.on("error", error => finish(error));
    child.on("close", code => finish(new Error(`MCP process exited before responding (${code})`)));
    child.stdout.on("data", chunk => {
      buffer += chunk.toString(); if (buffer.length > 2000000) { finish(new Error("MCP response too large")); return; }
      let newline;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let response: Rpc;
        try { response = JSON.parse(line) as Rpc; } catch { continue; }
        if (response.id !== 1 && response.id !== 2) continue;
        if (response.error) { finish(new Error(response.error.message || "MCP server error")); return; }
        if (response.id === 1) { send("notifications/initialized", {}); send(method, params, 2); }
        if (response.id === 2) { finish(undefined, response.result); return; }
      }
    });
    child.stderr.resume(); // Never log stderr that could include connector credentials.
    send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "local-desktop", version: "1.0" } }, 1);
  });
}
