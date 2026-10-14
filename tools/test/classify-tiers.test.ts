import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyAll,
  fetchWithRetry,
  formatSummary,
  parseArgs,
  skipReason,
  type Args,
  type Classification,
  type Deps,
  type ListedPost,
} from "../classify-tiers.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const args = (over: Partial<Args> = {}): Args => ({ apiUrl: "https://api.test", dryRun: false, force: false, delayMs: 0, limit: undefined, ...over });

const post = (id: number, over: Partial<ListedPost> = {}): ListedPost => ({ id, slug: `s${id}`, tier: null, tier_locked: false, ...over });

const classification = (over: Partial<Classification> = {}): Classification => ({
  tier: 3,
  confidence: 0.58,
  fallback: true,
  gate: "short",
  length: 212,
  probabilities: {},
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** 一覧と classify と PATCH を持つ偽の API。 */
function fakeApi(posts: ListedPost[], opts: { classify?: (id: number, call: number) => Response; patch?: (id: number) => Response } = {}) {
  const calls: Call[] = [];
  const classifyCount = new Map<number, number>();
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + (method === "GET" ? u.search : ""), body });
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tok");
    if (method === "GET") {
      const page = Number(u.searchParams.get("page"));
      const limit = Number(u.searchParams.get("limit"));
      return json({ posts: posts.slice((page - 1) * limit, page * limit), page, limit, total: posts.length });
    }
    const id = Number(u.pathname.split("/")[3]);
    if (u.pathname.endsWith("/classify")) {
      const n = (classifyCount.get(id) ?? 0) + 1;
      classifyCount.set(id, n);
      return opts.classify ? opts.classify(id, n) : json(classification());
    }
    return opts.patch ? opts.patch(id) : json({ id });
  };
  const slept: number[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const deps: Deps = { fetch: fetchFn, sleep: async (ms) => void slept.push(ms), log: (l) => logs.push(l), warn: (l) => warns.push(l) };
  return { deps, calls, slept, logs, warns };
}

const sent = (calls: Call[], suffix: string) => calls.filter((c) => c.path.endsWith(suffix));

test("引数: 既定値と指定", () => {
  assert.deepEqual(parseArgs(["--api-url", "https://api.test/"]), args({ delayMs: 500 }));
  assert.deepEqual(
    parseArgs(["--api-url", "https://api.test", "--dry-run", "--force", "--delay-ms", "0", "--limit", "5"]),
    args({ dryRun: true, force: true, delayMs: 0, limit: 5 }),
  );
});

test("引数: api-url が無い、数でない、未知の引数は誤り", () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--api-url", "x", "--limit", "0"]));
  assert.throws(() => parseArgs(["--api-url", "x", "--delay-ms", "abc"]));
  assert.throws(() => parseArgs(["--api-url", "x", "--bogus"]));
});

test("飛ばす記事: ロック済みは常に、判定済みは --force なしのとき", () => {
  assert.equal(skipReason(post(1, { tier_locked: true }), true), "locked");
  assert.equal(skipReason(post(1, { tier: 2 }), false), "judged");
  assert.equal(skipReason(post(1, { tier: 2 }), true), undefined);
  assert.equal(skipReason(post(1), false), undefined);
  assert.equal(skipReason(post(1, { tier: 2, tier_locked: true }), false), "locked");
});

test("判定済みとロック済みを classify に送らない", async () => {
  const api = fakeApi([post(1), post(2, { tier: 1 }), post(3, { tier_locked: true }), post(4)]);
  const s = await classifyAll(api.deps, args(), "tok");
  assert.deepEqual(
    sent(api.calls, "/classify").map((c) => c.path),
    ["/api/posts/1/classify", "/api/posts/4/classify"],
  );
  assert.equal(s.skippedJudged, 1);
  assert.equal(s.skippedLocked, 1);
});

test("--force は判定済みを送り直し、ロック済みは送らない", async () => {
  const api = fakeApi([post(1, { tier: 2 }), post(2, { tier: 2, tier_locked: true })]);
  await classifyAll(api.deps, args({ force: true }), "tok");
  assert.deepEqual(
    sent(api.calls, "/classify").map((c) => c.path),
    ["/api/posts/1/classify"],
  );
});

test("--dry-run は PATCH を送らず、件数を数える", async () => {
  const api = fakeApi([post(1), post(2)], {
    classify: (id) => json(id === 1 ? classification({ tier: 2, fallback: false, gate: "long" }) : classification()),
  });
  const s = await classifyAll(api.deps, args({ dryRun: true }), "tok");
  assert.equal(sent(api.calls, "/tier").length, 0);
  assert.deepEqual(s.byTier, { 2: 1, 3: 1 });
  assert.equal(s.fallbacks, 1);
  assert.equal(s.written, 0);
  assert.equal(api.logs.length, 2);
  assert.match(api.logs[1], /^2\ts2\tlength=212\tgate=short\ttier=3\tconfidence=0.58\tfallback=true$/);
});

test("PATCH は auto の書き方で tier と confidence を送る", async () => {
  const api = fakeApi([post(7)]);
  await classifyAll(api.deps, args(), "tok");
  assert.deepEqual(sent(api.calls, "/tier"), [{ method: "PATCH", path: "/api/posts/7/tier", body: { tier: 3, tier_confidence: 0.58, source: "auto" } }]);
});

test("PATCH が 409 なら上書きできなかった数に入れ、エラーにしない", async () => {
  const api = fakeApi([post(1), post(2)], { patch: (id) => (id === 1 ? json({ error: "tier is locked" }, 409) : json({ id })) });
  const s = await classifyAll(api.deps, args(), "tok");
  assert.equal(s.lockedMeanwhile, 1);
  assert.equal(s.written, 1);
  assert.equal(s.errors, 0);
});

test("--limit は判定する記事の数を数え、飛ばした記事は数えない", async () => {
  const api = fakeApi([post(1, { tier: 1 }), post(2), post(3), post(4)]);
  const s = await classifyAll(api.deps, args({ limit: 2 }), "tok");
  assert.deepEqual(
    sent(api.calls, "/classify").map((c) => c.path),
    ["/api/posts/2/classify", "/api/posts/3/classify"],
  );
  assert.equal(s.classified, 2);
});

test("一覧は 50 件ずつ最後まで読む", async () => {
  const posts = Array.from({ length: 120 }, (_, i) => post(i + 1, { tier: 1 }));
  const api = fakeApi(posts);
  const s = await classifyAll(api.deps, args(), "tok");
  assert.equal(s.total, 120);
  assert.equal(api.calls.filter((c) => c.method === "GET").length, 3);
});

test("429 は間隔を広げて再試行し、成功すれば続ける", async () => {
  const api = fakeApi([post(1)], { classify: (_id, n) => (n < 3 ? json({}, 429) : json(classification())) });
  const s = await classifyAll(api.deps, args(), "tok");
  assert.equal(sent(api.calls, "/classify").length, 3);
  assert.deepEqual(api.slept.slice(0, 2), [1000, 2000]);
  assert.equal(s.classified, 1);
  assert.equal(s.errors, 0);
});

test("5xx が続けば初回を含め 4 回で諦め、次の記事へ進む", async () => {
  const api = fakeApi([post(1), post(2)], { classify: (id) => (id === 1 ? json({}, 503) : json(classification())) });
  const s = await classifyAll(api.deps, args(), "tok");
  assert.equal(sent(api.calls, "/posts/1/classify").length, 4);
  assert.deepEqual(api.slept.slice(0, 3), [1000, 2000, 4000]);
  assert.equal(s.errors, 1);
  assert.equal(s.classified, 1);
  assert.match(api.warns[0], /error 1 s1: classify 503/);
});

test("400 台（429 以外）は再試行しない", async () => {
  const api = fakeApi([post(1)], { classify: () => json({ error: "no" }, 404) });
  const s = await classifyAll(api.deps, args(), "tok");
  assert.equal(sent(api.calls, "/classify").length, 1);
  assert.equal(s.errors, 1);
});

test("通信の例外も再試行し、尽きたら投げる", async () => {
  let calls = 0;
  const failing = async (): Promise<Response> => {
    calls++;
    throw new Error("network");
  };
  await assert.rejects(fetchWithRetry(failing, async () => {}, "https://api.test", {}), /network/);
  assert.equal(calls, 4);
});

test("要約は tier ごとの件数とフォールバックの件数を出す", () => {
  const lines = formatSummary(
    { total: 5, skippedLocked: 1, skippedJudged: 1, lockedMeanwhile: 0, classified: 3, written: 0, fallbacks: 2, errors: 0, byTier: { 2: 1, 3: 2 } },
    true,
  );
  assert.equal(lines[0], "dry-run: posts=5 classified=3 tier1=0 tier2=1 tier3=2 fallback=2");
});
