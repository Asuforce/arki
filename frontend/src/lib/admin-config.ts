import { getSecret } from "astro:env/server";
import { createAdminApi, type AdminApi } from "./admin-api";

export function loadAdminApi(): AdminApi | null {
  const token = getSecret("ADMIN_TOKEN");
  if (!token) return null;
  const base = (import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
  return createAdminApi({ base, token });
}
