import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { isLocalMode } from "@/lib/local/paths";

/** Internal boot handshake: a listener on the configured port is not necessarily this desktop instance. */
export async function GET(request: Request) {
  await connection();
  const expected = process.env.OPENMAN_DESKTOP_INSTANCE_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!isLocalMode() || request.headers.has("origin") || !expected) return Response.json({ error: "Internal desktop endpoint" }, { status: 403 });
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: "Internal desktop endpoint" }, { status: 403 });
  return Response.json({ ready: true }, { headers: { "Cache-Control": "no-store" } });
}
