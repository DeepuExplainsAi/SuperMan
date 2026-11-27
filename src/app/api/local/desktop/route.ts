import { requireSession } from "@/lib/session";
import { isLocalMode } from "@/lib/local/paths";
import { mintDesktopTicket } from "@/lib/local/services";
import { wsPort } from "@/lib/local/host-client";
export async function POST(request: Request) {
  await requireSession();
  if (!isLocalMode()) return Response.json({ error: "Local mode only" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const ticket = mintDesktopTicket(body.interactive === true);
  return Response.json({ url: `ws://127.0.0.1:${wsPort()}/ws/desktop?ticket=${ticket}` }, { headers: { "Cache-Control": "no-store" } });
}
