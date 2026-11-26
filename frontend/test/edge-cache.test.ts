import { test } from "node:test";
import assert from "node:assert/strict";
import { isCacheable, withEdgeCache, type EdgeCache } from "../src/lib/edge-cache.ts";
import { apiPurgePaths, postPurgePaths, purgePaths } from "../src/lib/admin-purge.ts";

const pub = "public, max-age=60, s-maxage=86400, stale-while-revalidate=86400";
const get = (url = "https://x.test/search?q=a", init: RequestInit = {}) => new Request(url, init);
const res = (cc: string | null, init: ResponseInit = {}) => new Response("ok", { ...init, headers: cc ? { "Cache-Control": cc, ...(init.headers as object) } : init.headers });

function memory(): EdgeCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (k) => store.get(k)?.clone(),
    put: async (k, r) => void store.set(k, r),
    delete: async (k) => store.delete(k),
  };
}

test("isCacheable: public + s-maxage の 200 GET だけ", () => {
  assert.equal(isCacheable(get(), res(pub)), true);
  assert.equal(isCacheable(get(), res("no-store")), false);
  assert.equal(isCacheable(get(), res("public, max-age=60")), false);
  assert.equal(isCacheable(get(), res(null)), false);
  assert.equal(isCacheable(get(), res(pub, { status: 404 })), false);
  assert.equal(isCacheable(get(), res(pub, { headers: { "Set-Cookie": "a=b" } })), false);
  assert.equal(isCacheable(get("https://x.test/", { method: "POST" }), res(pub)), false);
});

test("withEdgeCache: 2 回目は render しない", async () => {
  const cache = memory();
  const pending: Promise<unknown>[] = [];
  let calls = 0;
  const render = async () => (calls++, res(pub));
  await withEdgeCache(get(), cache, (p) => pending.push(p), render);
  await Promise.all(pending);
  const second = await withEdgeCache(get(), cache, (p) => pending.push(p), render);
  assert.equal(calls, 1);
  assert.equal(await second.text(), "ok");
  assert.equal(second.headers.get("X-Edge-Cache"), "HIT");
});

test("withEdgeCache: クエリが違えば別のキー", async () => {
  const cache = memory();
  const pending: Promise<unknown>[] = [];
  let calls = 0;
  const render = async () => (calls++, res(pub));
  await withEdgeCache(get("https://x.test/search?q=a"), cache, (p) => pending.push(p), render);
  await Promise.all(pending);
  await withEdgeCache(get("https://x.test/search?q=b"), cache, (p) => pending.push(p), render);
  assert.equal(calls, 2);
});

test("withEdgeCache: キャッシュや waitUntil が無ければ render だけ", async () => {
  let calls = 0;
  await withEdgeCache(get(), undefined, undefined, async () => (calls++, res(pub)));
  assert.equal(calls, 1);
});

test("postPurgePaths: 一覧・記事・カテゴリ・JST 月別パスを重複なく作り、カテゴリは trim する", () => {
  const paths = postPurgePaths([
    {
      slug: "2026/01/01/010000",
      categories: [" 日記 ", "tech"],
      published_at: "2025-12-31T16:00:00Z", // JST で 2026-01-01 01:00
    },
    {
      slug: "2026/01/01/010000",
      categories: ["tech", "  "],
    },
  ]);
  assert.deepEqual(paths.sort(), [
    "/",
    "/archive",
    "/archive/2026/1",
    "/category",
    "/category/%E6%97%A5%E8%A8%98",
    "/category/tech",
    "/entry/2026/01/01/010000",
    "/rss.xml",
    "/sitemap.xml",
  ]);
});

test("apiPurgePaths: SSR と一致する API パスを生成する", () => {
  const paths = apiPurgePaths([
    {
      slug: "2026/01/01/010000",
      categories: [" foo bar "],
      published_at: "2025-12-31T16:00:00Z",
    },
  ]);
  assert.deepEqual(paths.sort(), [
    "/api/archive",
    "/api/categories",
    "/api/posts/by-slug/2026/01/01/010000",
    "/api/posts?page=1&limit=20",
    "/api/posts?page=1&limit=20&category=foo+bar",
    "/api/posts?page=1&limit=50&month=2026-01",
    "/api/sitemap",
  ]);
});

test("purgePaths: Cache API の delete と Zone Purge API の両方を呼ぶ", async () => {
  const cache = memory();
  await cache.put("https://x.test/", res(pub));
  await cache.put("https://x.test/other", res(pub));

  const calls: { url: string; body: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  const ok = await purgePaths("https://x.test", ["/", "/entry/a"], cache, { zoneId: "z1", token: "t1" }, fakeFetch);
  assert.equal(ok, true);
  assert.equal(cache.store.has("https://x.test/"), false);
  assert.equal(cache.store.has("https://x.test/other"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/zones/z1/purge_cache");
  assert.deepEqual(JSON.parse(calls[0].body), { files: ["https://x.test/", "https://x.test/entry/a"] });
});

test("purgePaths: Zone Purge API が失敗したときは false を返す", async () => {
  const failStatus: typeof fetch = async () => new Response(JSON.stringify({ success: false }), { status: 403 });
  const failBody: typeof fetch = async () => new Response(JSON.stringify({ success: false }), { status: 200 });
  assert.equal(await purgePaths("https://x.test", ["/"], undefined, { zoneId: "z1", token: "t1" }, failStatus), false);
  assert.equal(await purgePaths("https://x.test", ["/"], undefined, { zoneId: "z1", token: "t1" }, failBody), false);
});
