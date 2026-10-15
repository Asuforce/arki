import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const TOC_TOKEN = "ARKITOCMARKER";

const IFRAME_HOSTS = ["www.youtube.com", "www.youtube-nocookie.com", "embed.music.apple.com"];

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "h1",
    "h2",
    "img",
    "figure",
    "figcaption",
    "span",
    "iframe",
    "details",
    "summary",
    "del",
    "ins",
    "cite",
  ],
  allowedAttributes: {
    a: ["href", "name", "title", "class", "rel", "target"],
    img: ["src", "alt", "title", "width", "height", "loading", "class"],
    iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "frameborder", "referrerpolicy", "loading"],
    span: ["class"],
    blockquote: ["class"],
    code: ["class"],
    pre: ["class"],
    td: ["align", "colspan", "rowspan"],
    th: ["align", "colspan", "rowspan"],
    ol: ["start"],
    li: ["value"],
  },
  // はてなの WYSIWYG が書く X の埋め込み (<blockquote class="twitter-tweet">) だけ class を残す
  allowedClasses: { blockquote: ["twitter-tweet"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedIframeHostnames: IFRAME_HOSTS,
  allowIframeRelativeUrls: false,
  // 許可しないホストの iframe は src が落ちて空になるので、タグごと消す
  exclusiveFilter: (frame) => frame.tag === "iframe" && !frame.attribs.src,
  transformTags: {
    a: (tagName, attribs) => {
      const external = /^https?:\/\//.test(attribs.href ?? "");
      return { tagName, attribs: external ? { ...attribs, rel: "noopener noreferrer" } : attribs };
    },
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: "lazy" } }),
  },
};

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** 見出しに id を付け、目次の目印があれば `h2`/`h3` の一覧に置き換える。 */
function addHeadingIdsAndToc(html: string, withToc: boolean): string {
  const entries: { level: number; id: string; text: string }[] = [];
  let n = 0;
  const withIds = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
    const id = `h-${++n}`;
    entries.push({ level: Number(level), id, text: plainText(inner) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  if (!withToc) return withIds.replace(`<p>${TOC_TOKEN}</p>`, "");

  const items = entries.filter((e) => e.level === 2 || e.level === 3);
  const toc = items.length
    ? `<nav class="toc"><ul>${items
        .map((e) => `<li class="toc-l${e.level}"><a href="#${e.id}">${sanitizeHtml(e.text, { allowedTags: [] })}</a></li>`)
        .join("")}</ul></nav>`
    : "";
  return withIds.replace(`<p>${TOC_TOKEN}</p>`, toc);
}

function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** YouTube の URL から動画 ID と開始秒を取り出す。 */
export function parseYouTube(url: URL): { id: string; start?: number } | null {
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | undefined;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? undefined;
    else id = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = url.searchParams.get("t") ?? url.searchParams.get("start");
  const start = t ? Number(/^\d+$/.test(t) ? t : (/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(t) ?? []).slice(1).reduce((a, v, i) => a + Number(v ?? 0) * [3600, 60, 1][i], 0)) : 0;
  return { id, start: start > 0 ? start : undefined };
}

/** X（旧 Twitter）の投稿 URL なら、正規化した URL を返す。 */
export function parseTweet(url: URL): string | null {
  const host = url.hostname.replace(/^(www|mobile)\./, "");
  if (host !== "twitter.com" && host !== "x.com") return null;
  const m = /^\/(\w{1,15})\/status(?:es)?\/(\d+)/.exec(url.pathname);
  return m ? `https://twitter.com/${m[1]}/status/${m[2]}` : null;
}

/**
 * 段落に URL のリンクだけがあるとき、埋め込みに置き換える。
 * YouTube は iframe、X は公式の埋め込み (widgets.js が描く) 、それ以外のリンクは OGP 付きのカード用に class を付ける。
 * サニタイズ後に行うので、ここで足す HTML は自前で組んだものだけ。
 */
function embedStandaloneLinks(html: string): string {
  return html.replace(/(<p>)?<a ([^>]*)>([^<]*)<\/a>(<\/p>)?/g, (full, open: string | undefined, attrs: string, text: string, close: string | undefined) => {
    if (Boolean(open) !== Boolean(close)) return full;
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
    if (!href) return full;
    const card = /\bclass="link-card"/.test(attrs);
    const linkText = decodeAttr(text).trim();
    const target = decodeAttr(href);
    if (!card && (!open || (linkText !== target && linkText !== ""))) return full;
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return full; // 相対パス（記事内リンク）はそのまま
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return full;

    const yt = parseYouTube(url);
    if (yt) {
      const src = `https://www.youtube-nocookie.com/embed/${yt.id}${yt.start ? `?start=${yt.start}` : ""}`;
      return `<div class="embed embed-video"><iframe src="${src}" title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
    }
    const tweet = parseTweet(url);
    if (tweet) {
      return `<blockquote class="twitter-tweet" data-dnt="true"><a href="${escapeAttr(tweet)}" rel="noopener noreferrer">${escapeAttr(tweet)}</a></blockquote>`;
    }
    return `<a href="${escapeAttr(url.href)}" class="link-card" rel="noopener noreferrer">${escapeAttr(url.href)}</a>`;
  });
}

/** 記事の Markdown を、サニタイズ済みの HTML にする。 */
export function renderPost(markdown: string): string {
  const withToc = markdown.includes("<!-- toc -->");
  const source = markdown.replace(/^<!-- toc -->[ \t]*$/m, TOC_TOKEN).replaceAll("<!-- toc -->", "");
  const html = marked.parse(source, { gfm: true, breaks: true, async: false });
  return addHeadingIdsAndToc(embedStandaloneLinks(sanitizeHtml(html, sanitizeOptions)), withToc);
}
