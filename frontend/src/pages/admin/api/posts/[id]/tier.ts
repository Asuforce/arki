import type { APIRoute } from "astro";
import { adminApi, json, passThrough } from "../../../../../lib/admin-http";
import { tierPatchBody } from "../../../../../lib/tier-request";

export const POST: APIRoute = async ({ params, request }) => {
  const id = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const patch = tierPatchBody(await request.json().catch(() => null));
  if (id === null || patch === null) return json({ error: "invalid request" }, 400);
  return passThrough(await adminApi().send("PATCH", `/api/posts/${id}/tier`, patch, { "Content-Type": "application/json" }));
};
