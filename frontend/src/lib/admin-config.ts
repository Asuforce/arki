import { getSecret } from "astro:env/server";
import type { AccessConfig } from "./access";
import { createAdminApi, type AdminApi } from "./admin-api";

export function loadAccessConfig(): AccessConfig | null {
  const aud = getSecret("ACCESS_AUD");
  const teamDomain = getSecret("ACCESS_TEAM_DOMAIN");
  const email = getSecret("ADMIN_EMAIL");
  return aud && teamDomain && email ? { aud, teamDomain, email } : null;
}

export function loadAdminApi(): AdminApi | null {
  const token = getSecret("ADMIN_TOKEN");
  if (!token) return null;
  const base = (import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
  return createAdminApi({ base, token });
}

/** `astro dev` のときだけ、Access の代わりに素通しする。本番ビルドでは `import.meta.env.DEV` が偽に固定される。 */
export function devBypass(): boolean {
  return import.meta.env.DEV && getSecret("ADMIN_DEV_BYPASS") === "1";
}
