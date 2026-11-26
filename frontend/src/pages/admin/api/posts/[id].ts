import type { APIRoute } from "astro";
import { adminApi, json, passThrough, purgePostCache, safeJson, safeResponseJson } from "../../../../lib/admin-http";

function postId(raw: string | undefined): number | null {
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

export const GET: APIRoute = async ({ params }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  return passThrough(await adminApi().send("GET", `/api/posts/${id}`));
};

export const PUT: APIRoute = async ({ params, request, url, locals }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  const api = adminApi();
  const before = await api.getPost(id).catch(() => null);
  const raw = await request.text();
  const res = await api.send("PUT", `/api/posts/${id}`, raw, { "Content-Type": "application/json" });
  if (res.status === 200) {
    const input = safeJson<{ categories?: unknown; published_at?: unknown }>(raw);
    const updated = await safeResponseJson<{ slug?: string }>(res);
    const targets = [
      ...(before ? [{ slug: before.slug, categories: before.categories, published_at: before.published_at }] : []),
      {
        slug: updated?.slug ?? before?.slug,
        categories: Array.isArray(input?.categories) ? input.categories.filter((c): c is string => typeof c === "string") : [],
        published_at: typeof input?.published_at === "string" ? input.published_at : undefined,
      },
    ];
    await purgePostCache({ url, locals }, targets);
  }
  return passThrough(res);
};

export const DELETE: APIRoute = async ({ params, url, locals }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  const api = adminApi();
  const before = await api.getPost(id).catch(() => null);
  const res = await api.send("DELETE", `/api/posts/${id}`);
  if (res.status === 204) {
    await purgePostCache(
      { url, locals },
      before ? [{ slug: before.slug, categories: before.categories, published_at: before.published_at }] : [],
    );
  }
  return passThrough(res);
};
