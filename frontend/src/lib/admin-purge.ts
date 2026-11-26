import type { EdgeCache } from "./edge-cache";
import type { ZonePurgeConfig } from "./admin-config";

const JST_OFFSET_MS = 9 * 3600 * 1000;
const CF_PURGE_BATCH_LIMIT = 30;

export interface PurgeTarget {
  slug?: string | null;
  categories?: string[];
  published_at?: string | null;
}

function jstYearMonth(iso: string): { year: string; month: string } | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const jst = new Date(ms + JST_OFFSET_MS).toISOString();
  return { year: jst.slice(0, 4), month: jst.slice(5, 7) };
}

function encodeSlug(slug: string): string {
  return slug
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** 記事の作成・更新・削除で影響を受けるフロント側の公開パス一覧を作る。 */
export function postPurgePaths(targets: PurgeTarget[]): string[] {
  const paths = new Set<string>(["/", "/category", "/archive", "/rss.xml", "/sitemap.xml"]);
  for (const t of targets) {
    if (t.slug) {
      paths.add(`/entry/${encodeSlug(t.slug)}`);
    }
    for (const raw of t.categories ?? []) {
      const c = raw.trim();
      if (c) paths.add(`/category/${encodeURIComponent(c)}`);
    }
    if (t.published_at) {
      const ym = jstYearMonth(t.published_at);
      if (ym) paths.add(`/archive/${ym.year}/${Number(ym.month)}`);
    }
  }
  return [...paths];
}

/** 記事の作成・更新・削除で影響を受ける API 側の公開パス一覧を作る（SSR と同じクエリ順）。 */
export function apiPurgePaths(targets: PurgeTarget[]): string[] {
  const paths = new Set<string>(["/api/posts?page=1&limit=20", "/api/categories", "/api/archive", "/api/sitemap"]);
  for (const t of targets) {
    if (t.slug) {
      paths.add(`/api/posts/by-slug/${encodeSlug(t.slug)}`);
    }
    for (const raw of t.categories ?? []) {
      const c = raw.trim();
      if (c) paths.add(`/api/posts?page=1&limit=20&category=${encodeURIComponent(c)}`);
    }
    if (t.published_at) {
      const ym = jstYearMonth(t.published_at);
      if (ym) paths.add(`/api/posts?page=1&limit=50&month=${ym.year}-${ym.month}`);
    }
  }
  return [...paths];
}

/** 自 POP の Cache API と、設定されていれば Cloudflare Zone Cache を URL 指定で purge する。 */
export async function purgePaths(
  origin: string,
  paths: string[],
  cache: EdgeCache | undefined,
  zone: ZonePurgeConfig | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const urls = [...new Set(paths.map((p) => new URL(p, origin).toString()))];
  if (urls.length === 0) return true;

  let allOk = true;
  const tasks: Promise<unknown>[] = [];
  if (cache?.delete) {
    const del = cache.delete.bind(cache);
    for (const url of urls) {
      tasks.push(
        del(url).catch((error) => {
          console.error(`Cache API delete failed for ${url}:`, error);
          allOk = false;
        }),
      );
    }
  }
  if (zone?.zoneId && zone?.token) {
    for (let i = 0; i < urls.length; i += CF_PURGE_BATCH_LIMIT) {
      const files = urls.slice(i, i + CF_PURGE_BATCH_LIMIT);
      tasks.push(
        (async () => {
          try {
            const res = await fetchImpl(
              `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.zoneId)}/purge_cache`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${zone.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ files }),
              },
            );
            const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: unknown } | null;
            if (!res.ok || body?.success !== true) {
              console.error(`Cloudflare Zone Purge failed (${res.status}):`, body?.errors ?? body);
              allOk = false;
            }
          } catch (error) {
            console.error("Cloudflare Zone Purge request failed:", error);
            allOk = false;
          }
        })(),
      );
    }
  }
  await Promise.all(tasks);
  return allOk;
}
