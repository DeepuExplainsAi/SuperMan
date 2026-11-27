// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * The automatic local session for 100% local desktop operation.
 *
 * In Local Desktop Mode there is no Orgo account, no Orgo key and no cloud billing: the person using the
 * laptop *is* the owner. `getSession()` / `requireSession()` return this session for every loopback request,
 * in `next dev` and in a production `next start` bound to 127.0.0.1, so the app opens straight into the
 * workspace with zero sign-in.
 */
import type { Session } from "./index";
import { localUserId, localWorkspaceId, machineName } from "@/lib/local/paths";

export function localSession(): Session {
  return {
    userId: localUserId(),
    email: "local@localhost",
    name: machineName(),
    avatarUrl: null,
    plan: "Local",
    workspaceId: localWorkspaceId(),
    dev: false,
    via: "local",
    keyScope: "account",
  } as Session;
}

export function isLocalSession(session: Session): boolean {
  return session.userId === localUserId();
}
