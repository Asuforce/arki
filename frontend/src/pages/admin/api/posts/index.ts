import type { APIRoute } from "astro";
import { adminApi, passThrough } from "../../../../lib/admin-http";

export const POST: APIRoute = async ({ request }) =>
  passThrough(await adminApi().send("POST", "/api/posts", await request.text(), { "Content-Type": "application/json" }));
