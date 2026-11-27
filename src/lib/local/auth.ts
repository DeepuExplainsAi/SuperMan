import { randomBytes } from "node:crypto";
/** Internal service credential, never returned to renderer code. */
export function localServiceToken(): string {
  return process.env.OPENMAN_AGENT_TOKEN ??= randomBytes(32).toString("hex");
}
