import type { APIRoute } from "astro";
import { adminApi, fetchPurgeTarget, passThrough, purgePostCache, safeJson, safeResponseJson } from "../../../../lib/admin-http";

interface PostBody {
  categories?: unknown;
  published_at?: unknown;
}

export const POST: APIRoute = async ({ request, url }) => {
  const raw = await request.text();
  const api = adminApi();
  const res = await api.send("POST", "/api/posts", raw, { "Content-Type": "application/json" });
  const warnings: string[] = [];
  if (res.status === 201) {
    const created = await safeResponseJson<{ id?: number; slug?: string }>(res);
    const fetched = typeof created?.id === "number" ? await fetchPurgeTarget(api, created.id) : { failed: false };
    if (fetched.failed) warnings.push("after-fetch-failed");
    const input = safeJson<PostBody>(raw);
    const target = fetched.target ?? {
      slug: created?.slug,
      categories: Array.isArray(input?.categories) ? input.categories.filter((c): c is string => typeof c === "string") : [],
      published_at: typeof input?.published_at === "string" ? input.published_at : undefined,
    };
    const purged = await purgePostCache({ url }, [target]);
    if (!purged) warnings.push("purge-failed");
  }
  const extraHeaders = warnings.length > 0 ? { "X-Cache-Purge-Warning": warnings.join(", ") } : undefined;
  return passThrough(res, extraHeaders);
};
