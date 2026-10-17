/** Worker の応答は、`s-maxage` を付けるだけではエッジに残らない。Cache API に自分で入れる。 */

export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
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
  if (hit) return hit;
  const response = await render();
  if (isCacheable(request, response)) waitUntil(cache.put(request.url, response.clone()));
  return response;
}
