export interface AccessConfig {
  teamDomain: string;
  aud: string;
  email: string;
}

/** 署名鍵を取れない。JWT が悪いのではなく設定か Access 側の障害なので、401 にしない。 */
export class AccessUnavailableError extends Error {}

interface Jwk extends JsonWebKey {
  kid: string;
}

type KeyLoader = (teamDomain: string, refresh?: boolean) => Promise<Jwk[]>;

const KEYS_TTL_MS = 10 * 60 * 1000;
const KEYS_MIN_REFRESH_MS = 60 * 1000;
let keysCache: { at: number; teamDomain: string; keys: Jwk[] } | null = null;

const fetchKeys: KeyLoader = async (teamDomain, refresh = false) => {
  if (keysCache && keysCache.teamDomain === teamDomain) {
    const age = Date.now() - keysCache.at;
    // 鍵のローテーションで未知の kid が来たときだけ、間隔を空けて取り直す
    if (age < (refresh ? KEYS_MIN_REFRESH_MS : KEYS_TTL_MS)) return keysCache.keys;
  }
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`access certs: ${res.status}`);
    const { keys } = (await res.json()) as { keys: Jwk[] };
    keysCache = { at: Date.now(), teamDomain, keys };
    return keys;
  } catch (error) {
    throw new AccessUnavailableError(String(error));
  }
};

/** `/admin*` の外のページには `Cf-Access-Jwt-Assertion` が付かないので、Access が発行するクッキーから JWT を取る。別のアプリのクッキーが同名で並ぶことがあるので、全部返す。 */
export function accessCookies(header: string | null): string[] {
  const values: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "CF_Authorization" && value.length) values.push(value.join("="));
  }
  return values.filter(Boolean);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodePart<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

/** 検証に失敗したら null。許可したメール以外と、`email` を持たない Service Token 由来の JWT は通さない。 */
export async function verifyAccessJwt(
  jwt: string | null,
  config: AccessConfig,
  loadKeys: KeyLoader = fetchKeys,
  now: number = Date.now(),
): Promise<string | null> {
  const parts = jwt?.split(".");
  if (!parts || parts.length !== 3) return null;
  const [h, p, s] = parts;

  try {
    const header = decodePart<{ kid?: string; alg?: string }>(h);
    if (header.alg !== "RS256") return null;
    let jwk = (await loadKeys(config.teamDomain)).find((k) => k.kid === header.kid);
    jwk ??= (await loadKeys(config.teamDomain, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;

    const claims = decodePart<{ aud?: string[]; iss?: string; exp?: number; nbf?: number; email?: string }>(p);
    if (!claims.aud?.includes(config.aud)) return null;
    if (claims.iss !== `https://${config.teamDomain}`) return null;
    if (!claims.exp || claims.exp * 1000 < now) return null;
    if (claims.nbf && claims.nbf * 1000 > now) return null;
    if (claims.email?.toLowerCase() !== config.email.toLowerCase()) return null;
    return claims.email;
  } catch (error) {
    if (error instanceof AccessUnavailableError) throw error;
    return null;
  }
}

/** どれか 1 つのクッキーが検証を通ればそのメールを返す。 */
export async function verifyAccessCookie(
  header: string | null,
  config: AccessConfig,
  loadKeys: KeyLoader = fetchKeys,
  now: number = Date.now(),
): Promise<string | null> {
  for (const jwt of accessCookies(header)) {
    const email = await verifyAccessJwt(jwt, config, loadKeys, now);
    if (email) return email;
  }
  return null;
}
