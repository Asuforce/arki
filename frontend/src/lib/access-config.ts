import { getSecret } from "astro:env/server";
import type { AccessConfig } from "./access";

export function loadAccessConfig(): AccessConfig | null {
  const aud = getSecret("ACCESS_AUD");
  const teamDomain = getSecret("ACCESS_TEAM_DOMAIN");
  const email = getSecret("ADMIN_EMAIL");
  return aud && teamDomain && email ? { aud, teamDomain, email } : null;
}

/** `astro dev` のときだけ、Access の代わりに素通しする。本番ビルドでは `import.meta.env.DEV` が偽に固定される。 */
export function devBypass(): boolean {
  return import.meta.env.DEV && getSecret("ADMIN_DEV_BYPASS") === "1";
}
