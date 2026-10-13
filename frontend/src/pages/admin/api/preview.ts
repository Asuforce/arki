import type { APIRoute } from "astro";
import { json } from "../../../lib/admin-http";
import { renderPost } from "../../../lib/render";

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
  if (typeof body?.content !== "string") return json({ error: "content is required" }, 400);
  return json({ html: renderPost(body.content) });
};
