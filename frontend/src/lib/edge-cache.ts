/** Worker の応答は、`s-maxage` を付けるだけではエッジに残らない。Cache API に自分で入れる。 */

export const PUBLIC_CACHE_CONTROL = "public, max-age=60, s-maxage=86400, stale-while-revalidate=86400";
export const LIST_PAGE_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=300";
export const RSS_CACHE_CONTROL = "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600";

export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete?(key: string): Promise<boolean>;
}

/** 公開してよい応答だけ入れる。成功した GET で、共有キャッシュ向けの指定があり、クッキーを設定しないもの。 */
export function isCacheable(request: Request, response: Response): boolean {
  if (request.method !== "GET" || response.status !== 200) return false;
  if (response.headers.has("Set-Cookie")) return false;
  const control = response.headers.get("Cache-Control") ?? "";
  return /(^|,)\s*public\b/i.test(control) && /\bs-maxage=\d+/i.test(control);
}

/** 入っていればそれを返し、無ければ `render` の応答を（入れられるなら）入れて返す。 */
export async function withEdgeCache(
  request: Request,
  cache: EdgeCache | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  render: () => Promise<Response>,
): Promise<Response> {
  if (!cache || !waitUntil || request.method !== "GET") return render();
  const hit = await cache.match(request.url);
  // キャッシュから返した応答のヘッダーは読み取り専用のことがあるので、作り直す。確認用に印を付ける
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("X-Edge-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
  const response = await render();
  if (isCacheable(request, response)) waitUntil(cache.put(request.url, response.clone()));
  return response;
}
