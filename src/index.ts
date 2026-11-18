import type { Env } from "./types";
import { sanitizeRoomId, normalizeName, escapeHtml, randomUid } from "./validation";
import { renderPage } from "./ui/page";
import { record2svg, parseSvgParams } from "./svg";

// Durable Object classes must be exported from the Worker entrypoint.
export { ChatRoom } from "./chatRoom";

const NO_STORE = { "Cache-Control": "no-store" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return Response.redirect(new URL("/room/@demo", url).toString(), 302);
    }

    if (path === "/health") {
      return new Response("alive", { headers: NO_STORE });
    }

    if (path === "/filter") {
      const q = url.searchParams.get("q") || "";
      return new Response(escapeHtml(q.slice(0, 1000)), {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE },
      });
    }

    if (path === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426, headers: NO_STORE });
      }
      const roomId = sanitizeRoomId(url.searchParams.get("room"));
      if (!roomId) return new Response("Invalid room", { status: 400, headers: NO_STORE });
      // Empty names are left empty here; the DO generates a `user_xxxxx`
      // handle (reference behavior) so anonymous visitors stay distinguishable.
      const name = normalizeName(url.searchParams.get("name")) || "";
      const uidRaw = url.searchParams.get("uid");
      const uid = uidRaw && /^[A-Za-z0-9_-]{1,7}$/.test(uidRaw) ? uidRaw : randomUid();

      // Rebuild the URL passed to the DO with validated values only.
      const doUrl = new URL("https://room.internal/ws");
      doUrl.searchParams.set("room", roomId);
      doUrl.searchParams.set("name", name);
      doUrl.searchParams.set("uid", uid);
      doUrl.searchParams.set("title", (url.searchParams.get("title") || "").slice(0, 100));
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const roomMatch = path.match(/^\/room\/@([^/]+)(\/(record|svg))?$/);
    if (roomMatch) {
      const roomId = sanitizeRoomId(roomMatch[1]);
      if (!roomId) return new Response("Invalid room", { status: 400, headers: NO_STORE });
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
      const sub = roomMatch[2];

      if (sub === "/record") {
        const doUrl = new URL("https://room.internal/record");
        for (const key of ["limit", "offset"]) {
          const v = url.searchParams.get(key);
          if (v !== null) doUrl.searchParams.set(key, v);
        }
        return withNoStore(await stub.fetch(new Request(doUrl.toString(), request)));
      }

      if (sub === "/svg") {
        const params = parseSvgParams(url.searchParams);
        const doUrl = new URL("https://room.internal/svg");
        doUrl.searchParams.set("limit", String(params.limit));
        const rows = (await (await stub.fetch(new Request(doUrl.toString(), request))).json()) as Parameters<typeof record2svg>[0];
        const svg = record2svg(rows, params, roomId);
        return new Response(svg, {
          headers: { "Content-Type": "image/svg+xml; charset=utf-8", ...NO_STORE },
        });
      }

      const title = (url.searchParams.get("title") || "").slice(0, 100);
      return new Response(renderPage(roomId, title), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
      });
    }

    return new Response("Not found", { status: 404, headers: NO_STORE });
  },
} satisfies ExportedHandler<Env>;

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
