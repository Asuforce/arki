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
    iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "frameborder"],
    span: ["class"],
    code: ["class"],
    pre: ["class"],
    td: ["align", "colspan", "rowspan"],
    th: ["align", "colspan", "rowspan"],
    ol: ["start"],
    li: ["value"],
  },
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

/** 記事の Markdown を、サニタイズ済みの HTML にする。 */
export function renderPost(markdown: string): string {
  const withToc = markdown.includes("<!-- toc -->");
  const source = markdown.replace(/^<!-- toc -->[ \t]*$/m, TOC_TOKEN).replaceAll("<!-- toc -->", "");
  const html = marked.parse(source, { gfm: true, breaks: true, async: false });
  return addHeadingIdsAndToc(sanitizeHtml(html, sanitizeOptions), withToc);
}
