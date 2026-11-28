"use client";
import { brand, type ModeId } from "@/config/brand";
import { useEffect, useState } from "react";

type Desktop = { status(): Promise<{ autoStart: boolean; platform: string; version: string }>; setAutoStart(enabled: boolean): Promise<boolean> };
export default function LocalModels() {
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modeModels, setModeModels] = useState<Partial<Record<ModeId, string>>>({});
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  const desktop = () => (window as typeof window & { desktop?: Desktop }).desktop;
  useEffect(() => {
    let cancelled = false;
    fetch("/api/local/models").then(async (res) => { if (!res.ok) throw new Error("Model settings are available in local desktop mode."); return res.json(); }).then((config) => {
      if (cancelled) return;
      setProvider(config.provider === "none" ? "ollama" : config.provider); setModel(config.model === "local" ? "" : config.model); setHasKey(config.hasApiKey); setBaseUrl(config.baseUrl || ""); setModeModels(config.modeModels || {});
    }).catch((error) => { if (!cancelled) setStatus(String(error.message)); });
    desktop()?.status().then((info) => { if (!cancelled) setAutoStart(info.autoStart); });
    return () => { cancelled = true; };
  }, []);
  const local = provider === "ollama" || provider === "lmstudio";
  const field = "w-full rounded-lg border border-[var(--om-border)] bg-transparent p-3";
  async function save() {
    setStatus("Saving…");
    try {
      const res = await fetch("/api/local/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model, modeModels, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey ? { apiKey } : {}) }) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error);
      setHasKey(Boolean(apiKey) || hasKey); setApiKey(""); setStatus("Saved. New tasks will use this model.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Save failed"); }
  }
  async function discover() {
    setStatus("Looking for installed models…");
    try {
      const res = await fetch("/api/local/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error);
      setModels(body.models); if (!model && body.models[0]) setModel(body.models[0]); setStatus(`${body.models.length} models found`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Discovery failed"); }
  }
  return <section className="space-y-5 p-8 text-[var(--om-text-1)]">
    <h2 className="text-xl font-medium">AI Models & Providers</h2>
    <p>Your tasks, files, and database stay on this computer. Local models need no API key. Cloud providers receive your prompts and tool results when selected.</p>
    <label className="block space-y-2"><span>Provider</span><select className={field} value={provider} onChange={(event) => { setProvider(event.target.value); setModel(""); setModels([]); setHasKey(false); setBaseUrl(""); setModeModels({}); }}>
      <option value="ollama">Ollama · offline</option><option value="lmstudio">LM Studio / vLLM / llama.cpp · offline</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option><option value="openrouter">OpenRouter</option>
    </select></label>
    <label className="block space-y-2"><span>Model ID</span><input className={field} list="local-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder={local ? "Discover an installed model" : "Provider model ID"} /><datalist id="local-models">{models.map((name) => <option key={name} value={name} />)}</datalist></label>
    {local ? <button className={field} onClick={discover}>Discover installed models</button> : <label className="block space-y-2"><span>API key {hasKey ? "(saved securely; leave blank to keep)" : ""}</span><input type="password" autoComplete="off" className={field} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>}
    <label className="block space-y-2"><span>Server base URL (optional)</span><input className={field} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={local ? "http://127.0.0.1:11434/v1" : "Provider's official HTTPS endpoint"} /></label>
    <details className="space-y-3"><summary>Model per mode (blank uses the default above)</summary>{(Object.keys(brand.modes) as ModeId[]).map(mode => <label key={mode} className="block space-y-2"><span>{brand.modes[mode].label}</span><input className={field} value={modeModels[mode] || ""} onChange={event => setModeModels(previous => ({ ...previous, [mode]: event.target.value }))} placeholder={model || "Default model"} /></label>)}</details>
    <button className={field} disabled={!model.trim()} onClick={save}>Save model configuration</button>
    <p role="status">{status}</p>
    <h3 className="text-lg font-medium">Local hardware & background services</h3>
    <p>This laptop is the protected host computer. There are no VM charges or credit top-ups. Keep the application running in the system tray for scheduled automations.</p>
    {autoStart !== null && <label className="flex items-center gap-3"><input type="checkbox" checked={autoStart} onChange={async (event) => { const enabled = await desktop()?.setAutoStart(event.target.checked); if (enabled !== undefined) setAutoStart(enabled); }} />Launch automatically when computer starts</label>}
  </section>;
}
