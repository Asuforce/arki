import type { APIRoute } from "astro";
import { adminApi, json, passThrough } from "../../../../lib/admin-http";

function postId(raw: string | undefined): number | null {
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

export const GET: APIRoute = async ({ params }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  return passThrough(await adminApi().send("GET", `/api/posts/${id}`));
};

export const PUT: APIRoute = async ({ params, request }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  return passThrough(await adminApi().send("PUT", `/api/posts/${id}`, await request.text(), { "Content-Type": "application/json" }));
};

export const DELETE: APIRoute = async ({ params }) => {
  const id = postId(params.id);
  if (id === null) return json({ error: "id must be a number" }, 400);
  return passThrough(await adminApi().send("DELETE", `/api/posts/${id}`));
};
