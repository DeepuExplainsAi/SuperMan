// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * Next.js instrumentation: the start-up safety check for sign-in settings, a start-up line and every uncaught server error (render, route, action, proxy) go to the
 * operator log (`src/lib/observability/log.ts`: JSON on stdout plus an `ops_events` row). Node runtime only; the
 * logger is imported lazily so nothing Node-specific reaches the edge bundle.
 */
import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Fail fast: a production server with a sign-in bypass enabled exits at once with the reason (src/lib/session/bypass.ts).
  const { enforceSafeStartup } = await import("@/lib/session/startup");
  enforceSafeStartup();
  // Local Desktop Mode: bring up the embedded Postgres database (applies migrations) before serving requests.
  const { isLocalMode } = await import("@/lib/local/paths");
  if (isLocalMode()) {
    const { initLocalDb } = await import("@/lib/db/client");
    await initLocalDb();
    const { upsertAccount } = await import("@/lib/db/accounts");
    const { agentServerUrl } = await import("@/lib/local/paths");
    await upsertAccount({ userId: "local-user", email: "local@localhost", name: "Local User", workspaceId: "local-workspace", homeComputerId: "local-host", hermesBaseUrl: agentServerUrl() });
    const { startAgentServer } = await import("@/lib/local/agent-server");
    const { startHostServices } = await import("@/lib/local/services");
    const { startScheduler } = await import("@/lib/local/scheduler");
    await startAgentServer();
    await startHostServices();
    startScheduler();
    const { restoreSiteServices } = await import("@/lib/local/site-supervisor");
    await restoreSiteServices();
  }
  const { logServerStart } = await import("@/lib/observability/log");
  void logServerStart();
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { logEvent } = await import("@/lib/observability/log");
    const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest?: unknown }).digest) : undefined;
    await logEvent("error", "server.request_error", {
      error: err,
      data: { method: request.method, path: request.path.split("?")[0], routePath: context.routePath, routeType: context.routeType, digest },
    });
  } catch {
    /* never throw from the error hook */
  }
};
