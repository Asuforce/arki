import { test } from "node:test";
import assert from "node:assert/strict";
import { isCacheable, withEdgeCache, type EdgeCache } from "../src/lib/edge-cache.ts";

const pub = "public, max-age=60, s-maxage=600";
const get = (url = "https://x.test/search?q=a", init: RequestInit = {}) => new Request(url, init);
const res = (cc: string | null, init: ResponseInit = {}) => new Response("ok", { ...init, headers: cc ? { "Cache-Control": cc, ...(init.headers as object) } : init.headers });

function memory(): EdgeCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return { store, match: async (k) => store.get(k)?.clone(), put: async (k, r) => void store.set(k, r) };
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
