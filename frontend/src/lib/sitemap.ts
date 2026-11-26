import { escapeXml } from "./xml";

export interface SitemapEntry {
  slug: string;
  updated_at: string;
}

/** 公開記事の一覧から `lastmod` 付きの XML Sitemap を組み立てる。 */
export function renderSitemapXml(origin: string, entries: SitemapEntry[]): string {
  const base = origin.replace(/\/$/, "");
  const latest = entries[0]?.updated_at;
  const rootLastmod = latest ? `\n    <lastmod>${escapeXml(latest)}</lastmod>` : "";
  const urls = [
    `  <url>\n    <loc>${escapeXml(`${base}/`)}</loc>${rootLastmod}\n  </url>`,
    ...entries.map(
      (entry) =>
        `  <url>\n    <loc>${escapeXml(`${base}/entry/${entry.slug}`)}</loc>\n    <lastmod>${escapeXml(entry.updated_at)}</lastmod>\n  </url>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
