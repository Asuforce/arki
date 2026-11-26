import type { APIRoute } from "astro";
import { adminApi, fetchPurgeTarget, json, passThrough, purgePostCache } from "../../../../../lib/admin-http";

/** 一覧からの切り替え。API の PUT は title と content が要るので、読んでから書く。 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const id = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const body = (await request.json().catch(() => null)) as { status?: unknown; expected_updated_at?: unknown } | null;
  if (id === null || (body?.status !== "draft" && body?.status !== "published")) return json({ error: "invalid request" }, 400);

  const api = adminApi();
  const post = await api.getPost(id);
  if (!post) return json({ error: "Not Found" }, 404);
  const expected = typeof body.expected_updated_at === "string" ? body.expected_updated_at : post.updated_at;
  const res = await api.send(
    "PUT",
    `/api/posts/${id}`,
    JSON.stringify({ title: post.title, content: post.content, status: body.status, expected_updated_at: expected }),
    { "Content-Type": "application/json" },
  );
  const warnings: string[] = [];
  if (res.status === 200) {
    const after = await fetchPurgeTarget(api, id);
    if (after.failed) warnings.push("after-fetch-failed");
    const updated = await res
      .clone()
      .json()
      .catch(() => null) as { slug?: string } | null;
    const purged = await purgePostCache({ url }, [
      { slug: post.slug, categories: post.categories, published_at: post.published_at },
      after.target ?? { slug: updated?.slug ?? post.slug },
    ]);
    if (!purged) warnings.push("purge-failed");
  }
  const extraHeaders = warnings.length > 0 ? { "X-Cache-Purge-Warning": warnings.join(", ") } : undefined;
  return passThrough(res, extraHeaders);
};
