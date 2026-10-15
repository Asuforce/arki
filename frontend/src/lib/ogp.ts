/** ブログカード (`a.link-card`) を、リンク先の OGP を読んだカードにする。取れなければ元のリンクのまま。 */

export interface Ogp {
  title: string;
  description?: string;
  image?: string;
  site: string;
}

const TIMEOUT_MS = 3000;
const MAX_BYTES = 512 * 1024;
const MAX_CARDS = 12;
const OK_TTL_MS = 60 * 60 * 1000;
const NG_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; ogp: Ogp | null }>();

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return named[name.toLowerCase()] ?? m;
    const code = dec ? Number(dec) : parseInt(hex ?? "", 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** 内部向けのアドレスや、http(s) 以外は取りに行かない。 */
export function isFetchable(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.startsWith("[") || h.includes(":")) return false; // IPv6 リテラル
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return h.includes(".");
}

/** HTML の `<head>` から OGP を取り出す。 */
export function parseOgp(html: string, pageUrl: URL): Ogp | null {
  const head = html.slice(0, (html.search(/<\/head>/i) + 1 || html.length));
  const meta = new Map<string, string>();
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? "";
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, decodeEntities(attrs.content).trim());
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = meta.get("og:title") || meta.get("twitter:title") || (titleTag ? decodeEntities(titleTag).replace(/\s+/g, " ").trim() : "");
  if (!title) return null;
  let image: string | undefined;
  const rawImage = meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image");
  if (rawImage) {
    try {
      const u = new URL(rawImage, pageUrl);
      if (u.protocol === "https:") image = u.href;
      else if (u.protocol === "http:") {
        u.protocol = "https:";
        image = u.href; // 混在コンテンツを避ける
      }
    } catch {
      // 画像なしで続ける
    }
  }
  const description = meta.get("og:description") || meta.get("twitter:description") || meta.get("description");
  return {
    title: title.slice(0, 200),
    description: description?.slice(0, 300),
    image,
    site: meta.get("og:site_name") || pageUrl.hostname.replace(/^www\./, ""),
  };
}

async function readHead(res: Response): Promise<string> {
  const type = res.headers.get("content-type") ?? "";
  if (!/html/i.test(type) || !res.body) return "";
  const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    // </head> まで読めれば十分
    if (/<\/head>/i.test(new TextDecoder("latin1").decode(value))) break;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  try {
    return new TextDecoder(charset).decode(all);
  } catch {
    return new TextDecoder("utf-8").decode(all);
  }
}

export async function fetchOgp(target: string, fetcher: typeof fetch = fetch): Promise<Ogp | null> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (!isFetchable(url)) return null;
  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < (hit.ogp ? OK_TTL_MS : NG_TTL_MS)) return hit.ogp;

  let ogp: Ogp | null = null;
  try {
    const res = await fetcher(url.href, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; ArkiLinkCard/1.0)", "Accept-Language": "ja,en;q=0.8" },
    });
    if (res.ok && isFetchable(new URL(res.url || url.href))) ogp = parseOgp(await readHead(res), new URL(res.url || url.href));
  } catch {
    ogp = null;
  }
  cache.set(url.href, { at: Date.now(), ogp });
  return ogp;
}

function cardHtml(href: string, ogp: Ogp): string {
  const thumb = ogp.image ? `<img class="link-card-thumb" src="${escapeHtml(ogp.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "";
  const desc = ogp.description ? `<span class="link-card-desc">${escapeHtml(ogp.description)}</span>` : "";
  return `<a href="${escapeHtml(href)}" class="link-card has-ogp" rel="noopener noreferrer"><span class="link-card-body"><span class="link-card-title">${escapeHtml(ogp.title)}</span>${desc}<span class="link-card-site">${escapeHtml(ogp.site)}</span></span>${thumb}</a>`;
}

/** `renderPost` の出力にあるブログカードへ、OGP のタイトル・説明・画像を入れる。 */
export async function expandLinkCards(html: string, fetcher: typeof fetch = fetch): Promise<string> {
  const re = /<a href="([^"]*)" class="link-card" rel="noopener noreferrer">[^<]*<\/a>/g;
  const urls = [...new Set([...html.matchAll(re)].map((m) => m[1].replace(/&amp;/g, "&")))].slice(0, MAX_CARDS);
  if (urls.length === 0) return html;
  const results = new Map(await Promise.all(urls.map(async (u) => [u, await fetchOgp(u, fetcher)] as const)));
  return html.replace(re, (full, href: string) => {
    const ogp = results.get(href.replace(/&amp;/g, "&"));
    return ogp ? cardHtml(href.replace(/&amp;/g, "&"), ogp) : full;
  });
}
