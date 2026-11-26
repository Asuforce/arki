import type { APIRoute } from "astro";
import { listSitemapEntries } from "../lib/api";
import { renderSitemapXml } from "../lib/sitemap";

export const GET: APIRoute = async ({ url }) => {
  const entries = await listSitemapEntries();
  const xml = renderSitemapXml(url.origin, entries);
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
};
