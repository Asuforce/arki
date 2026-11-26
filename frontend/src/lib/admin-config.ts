import { getSecret } from "astro:env/server";
import { createAdminApi, type AdminApi } from "./admin-api";

export interface ZonePurgeConfig {
  zoneId: string;
  token: string;
}

export function loadAdminApi(): AdminApi | null {
  const token = getSecret("ADMIN_TOKEN");
  if (!token) return null;
  const base = (import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
  return createAdminApi({ base, token });
}

export function loadZonePurgeConfig(): ZonePurgeConfig | undefined {
  const zoneId = getSecret("CF_ZONE_ID");
  const token = getSecret("CF_PURGE_TOKEN");
  if (!zoneId || !token) return undefined;
  return { zoneId, token };
}
