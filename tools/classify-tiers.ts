/**
 * 公開中の記事に、API の Clef 判定でティアを付ける。
 *
 *   ADMIN_TOKEN=... npx tsx classify-tiers.ts --api-url <URL> [--dry-run] [--force] [--delay-ms 500] [--limit N]
 *
 * 判定済み（tier が入っている）記事と、ロック済みの記事は飛ばす。--force は判定済みをやり直すが、ロックは破らない。
 * --dry-run は classify だけを呼び、書き込まない。--limit は判定する記事の数の上限で、飛ばした記事は数えない。
 * 429 と 502 などの 5xx は間隔を広げて 3 回まで再試行し、それでも失敗した記事はエラーを出して次へ進む。
 * classify の 500 と 503 は設定の誤りなので、再試行せずに実行を中断する。連続 5 件が失敗しても中断する。
 */
import { pathToFileURL } from "node:url";

export interface Args {
  apiUrl: string;
  dryRun: boolean;
  force: boolean;
  delayMs: number;
  limit: number | undefined;
}

export function parseArgs(argv: string[]): Args {
  const usage = "usage: classify-tiers.ts --api-url <URL> [--dry-run] [--force] [--delay-ms 500] [--limit N]";
  const args: Args = { apiUrl: "", dryRun: false, force: false, delayMs: 500, limit: undefined };
  const count = (name: string, raw: string | undefined, min: number): number => {
    const n = Number(raw);
    if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < min) {
      throw new Error(`${name} must be an integer >= ${min}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-url") args.apiUrl = (argv[++i] ?? "").replace(/\/$/, "");
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--delay-ms") args.delayMs = count(a, argv[++i], 0);
    else if (a === "--limit") args.limit = count(a, argv[++i], 1);
    else throw new Error(`unknown argument: ${a}\n${usage}`);
  }
  if (!args.apiUrl) throw new Error(usage);
  return args;
}

export interface ListedPost {
  id: number;
  slug: string;
  tier: number | null;
  tier_locked: boolean;
}

export interface Classification {
  tier: number;
  confidence: number;
  fallback: boolean;
  gate: "long" | "short";
  length: number;
  probabilities: Record<string, number>;
}

export type SkipReason = "locked" | "judged";

export function skipReason(post: ListedPost, force: boolean): SkipReason | undefined {
  if (post.tier_locked) return "locked";
  if (post.tier !== null && !force) return "judged";
  return undefined;
}

export const MAX_RETRIES = 3;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_MS = 1000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 500 と 503 は、設定の誤りか binding の欠落なので、待っても直らない。 */
export const isConfigFailure = (status: number): boolean => status === 500 || status === 503;

export const isRetryable = (status: number): boolean => status === 429 || (status >= 500 && !isConfigFailure(status));

const retryAfterMs = (res: Response): number | undefined => {
  const seconds = Number(res.headers.get("Retry-After"));
  return res.headers.get("Retry-After")?.trim() && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

/** 1 秒、2 秒、4 秒と間隔を広げて MAX_RETRIES 回まで再試行する。429 の Retry-After があればそれだけ待つ。 */
export async function fetchWithRetry(fetchFn: Fetch, sleepFn: Sleep, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
    }
    if (res && (!isRetryable(res.status) || attempt >= MAX_RETRIES)) return res;
    const wait = (res?.status === 429 ? retryAfterMs(res) : undefined) ?? RETRY_BASE_MS * 2 ** attempt;
    await res?.body?.cancel();
    await sleepFn(wait);
  }
}

export interface Deps {
  fetch: Fetch;
  sleep: Sleep;
  log: (line: string) => void;
  warn: (line: string) => void;
}

export interface Summary {
  total: number;
  skippedLocked: number;
  skippedJudged: number;
  lockedMeanwhile: number;
  classified: number;
  written: number;
  fallbacks: number;
  errors: number;
  /** 実行を途中で止めた理由。 */
  aborted?: string;
  byTier: Record<number, number>;
}

const PAGE_SIZE = 50;

export async function listPublished(deps: Deps, args: Args, token: string): Promise<ListedPost[]> {
  const posts: ListedPost[] = [];
  for (let page = 1; ; page++) {
    const res = await fetchWithRetry(deps.fetch, deps.sleep, `${args.apiUrl}/api/posts?status=published&limit=${PAGE_SIZE}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET /api/posts failed: ${res.status}`);
    const body = (await res.json()) as { posts: ListedPost[]; total: number };
    for (const p of body.posts) {
      if (p.tier_locked === undefined) throw new Error("the list has no tier fields: is the token valid and the API updated?");
      posts.push(p);
    }
    if (body.posts.length === 0 || posts.length >= body.total) return posts;
  }
}

export async function classifyAll(deps: Deps, args: Args, token: string): Promise<Summary> {
  const posts = await listPublished(deps, args, token);
  const summary: Summary = {
    total: posts.length,
    skippedLocked: 0,
    skippedJudged: 0,
    lockedMeanwhile: 0,
    classified: 0,
    written: 0,
    fallbacks: 0,
    errors: 0,
    byTier: {},
  };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const request = (path: string, method: string, body?: unknown) =>
    fetchWithRetry(deps.fetch, deps.sleep, `${args.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  let failures = 0;
  for (const post of posts) {
    const reason = skipReason(post, args.force);
    if (reason === "locked") summary.skippedLocked++;
    else if (reason === "judged") summary.skippedJudged++;
    if (reason) continue;
    if (args.limit !== undefined && summary.classified + summary.errors >= args.limit) break;

    try {
      const res = await request(`/api/posts/${post.id}/classify`, "POST");
      if (isConfigFailure(res.status)) {
        summary.aborted = `classify ${res.status} on ${post.id}: ${(await res.text()).slice(0, 200)}`;
        break;
      }
      if (!res.ok) throw new Error(`classify ${res.status}`);
      const c = (await res.json()) as Classification;
      let locked = false;
      if (!args.dryRun) {
        const patch = await request(`/api/posts/${post.id}/tier`, "PATCH", { tier: c.tier, tier_confidence: c.confidence, source: "auto" });
        if (patch.status === 409) locked = true;
        else if (!patch.ok) throw new Error(`PATCH tier ${patch.status}`);
      }
      summary.classified++;
      summary.byTier[c.tier] = (summary.byTier[c.tier] ?? 0) + 1;
      if (c.fallback) summary.fallbacks++;
      if (locked) summary.lockedMeanwhile++;
      else if (!args.dryRun) summary.written++;
      deps.log(
        [post.id, post.slug, `length=${c.length}`, `gate=${c.gate}`, `tier=${c.tier}`, `confidence=${c.confidence}`, `fallback=${c.fallback}`].join("\t"),
      );
      failures = 0;
    } catch (e) {
      summary.errors++;
      failures++;
      deps.warn(`error ${post.id} ${post.slug}: ${e instanceof Error ? e.message : String(e)}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        summary.aborted = `${failures} posts failed in a row`;
        break;
      }
    }
    await deps.sleep(args.delayMs);
  }
  return summary;
}

export function formatSummary(s: Summary, dryRun: boolean): string[] {
  const tiers = [1, 2, 3].map((t) => `tier${t}=${s.byTier[t] ?? 0}`).join(" ");
  const lines = [
    `${dryRun ? "dry-run: " : ""}posts=${s.total} classified=${s.classified} ${tiers} fallback=${s.fallbacks}`,
    `written=${s.written} skipped(judged)=${s.skippedJudged} skipped(locked)=${s.skippedLocked} locked-meanwhile=${s.lockedMeanwhile} errors=${s.errors}`,
  ];
  if (s.aborted) lines.push(`aborted: ${s.aborted}`);
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.ADMIN_TOKEN;
  if (!token) throw new Error("ADMIN_TOKEN is not set");
  const deps: Deps = { fetch, sleep, log: console.log, warn: console.warn };
  const summary = await classifyAll(deps, args, token);
  for (const line of formatSummary(summary, args.dryRun)) console.log(line);
  if (summary.errors > 0 || summary.aborted) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
