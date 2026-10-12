import type { APIRoute } from "astro";
import { adminApi, json, passThrough } from "../../../../../lib/admin-http";

/** 一覧からの切り替え。API の PUT は title と content が要るので、読んでから書く。 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const body = (await request.json().catch(() => null)) as { status?: unknown; expected_updated_at?: unknown } | null;
  if (id === null || (body?.status !== "draft" && body?.status !== "published")) return json({ error: "invalid request" }, 400);

  const api = adminApi();
  const post = await api.getPost(id);
  if (!post) return json({ error: "Not Found" }, 404);
  const expected = typeof body.expected_updated_at === "string" ? body.expected_updated_at : post.updated_at;
  return passThrough(
    await api.send("PUT", `/api/posts/${id}`, JSON.stringify({ title: post.title, content: post.content, status: body.status, expected_updated_at: expected }), {
      "Content-Type": "application/json",
    }),
  );
};
