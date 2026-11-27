import { requireSession } from "@/lib/session";
import { readLocalModelConfig, writeLocalModelConfig } from "@/lib/db/local-models";
import { loadModelConfig, saveModelConfig } from "@/lib/local/agent-server";
import { isLocalMode } from "@/lib/local/paths";
import { readJson } from "@/lib/orgo/http";
import { z } from "zod";

const configSchema = z.object({
  provider: z.enum(["ollama", "lmstudio", "openai", "anthropic", "gemini", "openrouter", "none"]),
  modeModels: z.object({ lite: z.string().max(200).optional(), standard: z.string().max(200).optional(), max: z.string().max(200).optional(), flex: z.string().max(200).optional() }).optional(),
  model: z.string().min(1).max(200), apiKey: z.string().max(1000).optional(),
  baseUrl: z.string().url().optional(),
});
function validateBase(url: string | undefined, provider: string): void {
  if (!url) return;
  const parsed = new URL(url);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const official: Record<string, string> = { openai: "api.openai.com", anthropic: "api.anthropic.com", gemini: "generativelanguage.googleapis.com", openrouter: "openrouter.ai" };
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (!local && (parsed.protocol !== "https:" || official[provider] !== parsed.hostname))) throw new Error("Use a loopback model server or the provider's official HTTPS endpoint.");
  if (local && !["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid local server protocol");
}
export async function GET() {
  await requireSession();
  if (!isLocalMode()) return Response.json({ error: "Local mode only" }, { status: 404 });
  const config = (await readLocalModelConfig()) ?? loadModelConfig();
  const { apiKey, ...publicConfig } = config;
  return Response.json({ ...publicConfig, hasApiKey: Boolean(apiKey) });
}
export async function PUT(request: Request) {
  await requireSession();
  if (!isLocalMode()) return Response.json({ error: "Local mode only" }, { status: 404 });
  try {
    const config = configSchema.parse(await readJson(request as Parameters<typeof readJson>[0], 8192));
    validateBase(config.baseUrl, config.provider);
    const previous = (await readLocalModelConfig()) ?? loadModelConfig();
    if (config.apiKey === undefined && config.provider === previous.provider) config.apiKey = previous.apiKey;
    await writeLocalModelConfig(config);
    saveModelConfig(config);
    return Response.json({ saved: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid configuration" }, { status: 400 }); }
}
export async function POST(request: Request) {
  await requireSession();
  if (!isLocalMode()) return Response.json({ error: "Local mode only" }, { status: 404 });
  try {
    const { provider, baseUrl } = z.object({ provider: z.enum(["ollama", "lmstudio"]), baseUrl: z.string().url().optional() }).parse(await readJson(request as Parameters<typeof readJson>[0], 8192));
    validateBase(baseUrl, provider);
    const base = (baseUrl || (provider === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:1234/v1")).replace(/\/$/, "");
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("Local model server did not return models");
    const data = await res.json() as { data?: { id: string }[] };
    return Response.json({ models: (data.data ?? []).map((item) => item.id) });
  } catch { return Response.json({ error: "Start your local model server, then try discovery again." }, { status: 503 }); }
}
