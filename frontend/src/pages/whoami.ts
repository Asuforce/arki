import type { APIRoute } from "astro";
import { isAdminRequest } from "../lib/admin-auth";

/** ログイン中かどうかを返す。 */
export const GET: APIRoute = async ({ request }) =>
  new Response(JSON.stringify({ admin: await isAdminRequest(request) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
