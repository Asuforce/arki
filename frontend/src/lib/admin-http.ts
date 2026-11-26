import type { APIContext } from "astro";
import type { AdminApi } from "./admin-api";
import { loadAdminApi, loadZonePurgeConfig } from "./admin-config";
import { postPurgePaths, purgePaths, type PurgeTarget } from "./admin-purge";
import type { EdgeCache } from "./edge-cache";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 上流の 401 と 403 は ADMIN_TOKEN の不一致で、Access の JWT 切れ（middleware の 401）と区別できるよう 502 にする。 */
export async function passThrough(res: Response): Promise<Response> {
  if (res.status === 204) return new Response(null, { status: 204 });
  if (res.status === 401 || res.status === 403) return json({ error: "the API rejected ADMIN_TOKEN" }, 502);
  if (!(res.headers.get("Content-Type") ?? "").includes("json")) return json({ error: `the API returned ${res.status}` }, res.status >= 400 ? res.status : 502);
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
}

export function adminApi(): AdminApi {
  const api = loadAdminApi();
  if (!api) throw new Error("ADMIN_TOKEN is not set");
  return api;
}

export function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function safeResponseJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.clone().json()) as T;
  } catch {
    return null;
  }
}

/** 投稿の作成・更新・削除後に該当 URL のエッジキャッシュを無効化する。 */
export async function purgePostCache(context: Pick<APIContext, "url" | "locals">, targets: PurgeTarget[]): Promise<void> {
  const cache = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
  const zone = loadZonePurgeConfig();
  if (!cache?.delete && !zone) return;

  const paths = postPurgePaths(targets);
  const task = purgePaths(context.url.origin, paths, cache, zone);
  const cfContext = (context.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
  if (cfContext) {
    cfContext.waitUntil(task);
  } else {
    await task;
  }
}
