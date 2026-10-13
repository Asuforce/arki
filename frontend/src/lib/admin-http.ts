import type { AdminApi } from "./admin-api";
import { loadAdminApi } from "./admin-config";

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
