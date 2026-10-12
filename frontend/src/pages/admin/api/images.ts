import type { APIRoute } from "astro";
import { adminApi, json, passThrough } from "../../../lib/admin-http";

const MAX_BYTES = 10 * 1024 * 1024;

export const POST: APIRoute = async ({ request }) => {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_BYTES) return json({ error: "image must be 10MB or smaller" }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return json({ error: "image must be 10MB or smaller" }, 413);
  return passThrough(await adminApi().send("POST", "/api/images", body, { "Content-Type": "application/octet-stream" }));
};
