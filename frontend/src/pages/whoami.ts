import type { APIRoute } from "astro";
import { AccessUnavailableError, verifyAccessCookie } from "../lib/access";
import { devBypass, loadAccessConfig } from "../lib/access-config";

async function isAdmin(request: Request): Promise<boolean> {
  if (devBypass()) return true;
  const config = loadAccessConfig();
  if (!config) return false;
  try {
    return (await verifyAccessCookie(request.headers.get("Cookie"), config)) !== null;
  } catch (error) {
    if (error instanceof AccessUnavailableError) return false;
    throw error;
  }
}

/** 公開ページは共有キャッシュされるので、ログイン中かどうかはこの口で別に尋ねる。 */
export const GET: APIRoute = async ({ request }) =>
  new Response(JSON.stringify({ admin: await isAdmin(request) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
