import type { APIRoute } from "astro";

export const GET: APIRoute = ({ url }) => {
  const body = [
    "User-agent: Claude-SearchBot",
    "Disallow: /",
    "",
    "User-agent: meta-webindexer",
    "Disallow: /",
    "",
    "User-agent: *",
    "Disallow: /admin",
    "",
    `Sitemap: ${url.origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
};
