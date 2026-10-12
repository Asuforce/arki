import { defineMiddleware } from "astro:middleware";
import { AccessUnavailableError, verifyAccessJwt } from "./lib/access";
import { devBypass, loadAccessConfig, loadAdminApi } from "./lib/admin-config";

declare global {
  namespace App {
    interface Locals {
      adminEmail?: string;
    }
  }
}

const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");
// Access は /admin* しか守らない。使っていないが、Astro が自動で公開する口は閉じておく
const isUnusedFrameworkPath = (path: string): boolean => path.startsWith("/_actions") || path.startsWith("/_server-islands");

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** 他のサイトからのフォーム送信や fetch で、ログイン中の管理者に書き込ませない。 */
function isSameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  return request.headers.get("Origin") === url.origin;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  if (isUnusedFrameworkPath(url.pathname)) return text(404, "Not Found");
  if (!isAdminPath(url.pathname)) return next();

  if (devBypass()) {
    context.locals.adminEmail = "dev@localhost";
  } else {
    const config = loadAccessConfig();
    if (!config) return text(503, "admin is not configured");
    let email: string | null;
    try {
      email = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), config);
    } catch (error) {
      if (error instanceof AccessUnavailableError) return text(503, "access keys are unavailable");
      throw error;
    }
    if (!email) return text(401, "Unauthorized");
    context.locals.adminEmail = email;
  }
  if (!loadAdminApi()) return text(503, "admin is not configured");

  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request, url)) {
    return text(403, "Forbidden");
  }

  let response: Response;
  try {
    response = await next();
  } catch {
    response = text(500, "Internal Server Error");
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
});
