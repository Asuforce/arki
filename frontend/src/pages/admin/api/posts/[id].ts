import type { APIRoute } from "astro";
import { adminApi, fetchPurgeTarget, json, passThrough, purgePostCache, safeJson, safeResponseJson } from "../../../../lib/admin-http";

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
  const before = await fetchPurgeTarget(api, id);
  const raw = await request.text();
  const res = await api.send("PUT", `/api/posts/${id}`, raw, { "Content-Type": "application/json" });
  const warnings: string[] = [];
  if (before.failed) warnings.push("before-fetch-failed");
  if (res.status === 200) {
    const after = await fetchPurgeTarget(api, id);
    if (after.failed) warnings.push("after-fetch-failed");
    const input = safeJson<{ categories?: unknown; published_at?: unknown }>(raw);
    const updated = await safeResponseJson<{ slug?: string }>(res);
    const fallbackAfter = {
      slug: updated?.slug ?? before.target?.slug,
      categories: Array.isArray(input?.categories) ? input.categories.filter((c): c is string => typeof c === "string") : [],
      published_at: typeof input?.published_at === "string" ? input.published_at : undefined,
    };
    const targets = [
      ...(before.target ? [before.target] : []),
      after.target ?? fallbackAfter,
    ];
    await purgePostCache({ url, locals }, targets);
  }
  const extraHeaders = warnings.length > 0 ? { "X-Cache-Purge-Warning": warnings.join(", ") } : undefined;
  return passThrough(res, extraHeaders);
};

export const DELETE: APIRoute = async ({ params, url, locals }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  const api = adminApi();
  const before = await fetchPurgeTarget(api, id);
  const res = await api.send("DELETE", `/api/posts/${id}`);
  if (res.status === 204) {
    await purgePostCache({ url, locals }, before.target ? [before.target] : []);
  }
  const extraHeaders = before.failed ? { "X-Cache-Purge-Warning": "before-fetch-failed" } : undefined;
  return passThrough(res, extraHeaders);
};
