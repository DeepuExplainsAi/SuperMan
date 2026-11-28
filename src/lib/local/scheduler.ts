import { appServerPort } from "./paths";
import { logEvent } from "@/lib/observability/log";

const state = globalThis as typeof globalThis & { __localScheduler?: ReturnType<typeof setInterval>; __localTickBusy?: boolean };
export async function schedulerTick(): Promise<boolean> {
  if (state.__localTickBusy) return false;
  state.__localTickBusy = true;
  try {
    const res = await fetch(`http://127.0.0.1:${appServerPort()}/api/cron/tick`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) throw new Error(`Scheduler returned HTTP ${res.status}`);
    return true;
  } finally { state.__localTickBusy = false; }
}
export function startScheduler(): void {
  if (state.__localScheduler) return;
  state.__localScheduler = setInterval(() => {
    void schedulerTick().catch((error) => logEvent("warn", "local.scheduler_failed", { error }));
  }, 60000);
  state.__localScheduler.unref();
}
export function stopScheduler(): void {
  clearInterval(state.__localScheduler); delete state.__localScheduler;
}
