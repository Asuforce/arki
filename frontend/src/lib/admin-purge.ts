import type { EdgeCache } from "./edge-cache";
import type { ZonePurgeConfig } from "./admin-config";

const JST_OFFSET_MS = 9 * 3600 * 1000;
const CF_PURGE_BATCH_LIMIT = 30;

export interface PurgeTarget {
  slug?: string | null;
  categories?: string[];
  published_at?: string | null;
}

/** 記事の作成・更新・削除で影響を受ける公開パスの一覧を作る。 */
export function postPurgePaths(targets: PurgeTarget[]): string[] {
  const paths = new Set<string>(["/", "/category", "/archive", "/rss.xml"]);
  for (const t of targets) {
    if (t.slug) {
      const encodedSlug = t.slug
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      paths.add(`/entry/${encodedSlug}`);
    }
    for (const c of t.categories ?? []) {
      if (c) paths.add(`/category/${encodeURIComponent(c)}`);
    }
    if (t.published_at) {
      const ms = Date.parse(t.published_at);
      if (!Number.isNaN(ms)) {
        const jst = new Date(ms + JST_OFFSET_MS).toISOString();
        const year = jst.slice(0, 4);
        const month = Number(jst.slice(5, 7));
        paths.add(`/archive/${year}/${month}`);
      }
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
): Promise<void> {
  const urls = [...new Set(paths.map((p) => new URL(p, origin).toString()))];
  if (urls.length === 0) return;

  const tasks: Promise<unknown>[] = [];
  if (cache?.delete) {
    const del = cache.delete.bind(cache);
    for (const url of urls) {
      tasks.push(del(url).catch(() => false));
    }
  }
  if (zone?.zoneId && zone?.token) {
    for (let i = 0; i < urls.length; i += CF_PURGE_BATCH_LIMIT) {
      const files = urls.slice(i, i + CF_PURGE_BATCH_LIMIT);
      tasks.push(
        fetchImpl(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.zoneId)}/purge_cache`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${zone.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ files }),
        }).catch(() => undefined),
      );
    }
  }
  await Promise.all(tasks);
}
