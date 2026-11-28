import { getSettings, patchSettings } from "./settings";
import { seal, open } from "@/lib/crypto";
import type { ModelConfig } from "@/lib/local/agent-server";

export async function readLocalModelConfig(): Promise<ModelConfig | null> {
  const settings = await getSettings("local-user");
  return typeof settings.localModelConfig === "string" ? JSON.parse(open(settings.localModelConfig)) as ModelConfig : null;
}
export async function writeLocalModelConfig(config: ModelConfig): Promise<void> {
  await patchSettings("local-user", { localModelConfig: seal(JSON.stringify(config)) });
}
