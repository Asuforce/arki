import type { APIRoute } from "astro";
import { adminApi, passThrough, purgePostCache, safeJson, safeResponseJson } from "../../../../lib/admin-http";

interface PostBody {
  categories?: unknown;
  published_at?: unknown;
}

export const POST: APIRoute = async ({ request, url, locals }) => {
  const raw = await request.text();
  const res = await adminApi().send("POST", "/api/posts", raw, { "Content-Type": "application/json" });
  if (res.status === 201) {
    const input = safeJson<PostBody>(raw);
    const created = await safeResponseJson<{ slug?: string }>(res);
    await purgePostCache({ url, locals }, [
      {
        slug: created?.slug,
        categories: Array.isArray(input?.categories) ? input.categories.filter((c): c is string => typeof c === "string") : [],
        published_at: typeof input?.published_at === "string" ? input.published_at : undefined,
      },
    ]);
  }
  return passThrough(res);
};
