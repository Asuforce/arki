import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSitemapXml } from "../src/lib/sitemap.ts";

test("renderSitemapXml: ルートと各記事に lastmod を付ける", () => {
  const xml = renderSitemapXml("https://blog.example.com/", [
    { slug: "2026/11/25/120000", updated_at: "2026-11-25T03:00:00Z" },
    { slug: "2026/11/24/090000", updated_at: "2026-11-24T00:00:00Z" },
  ]);
  assert.match(xml, /<loc>https:\/\/blog\.example\.com\/<\/loc>\s*<lastmod>2026-11-25T03:00:00Z<\/lastmod>/);
  assert.match(
    xml,
    /<loc>https:\/\/blog\.example\.com\/entry\/2026\/11\/25\/120000<\/loc>\s*<lastmod>2026-11-25T03:00:00Z<\/lastmod>/,
  );
  assert.match(
    xml,
    /<loc>https:\/\/blog\.example\.com\/entry\/2026\/11\/24\/090000<\/loc>\s*<lastmod>2026-11-24T00:00:00Z<\/lastmod>/,
  );
});

test("renderSitemapXml: 記事が 0 件でもルートだけ出力する", () => {
  const xml = renderSitemapXml("https://blog.example.com", []);
  assert.match(xml, /<loc>https:\/\/blog\.example\.com\/<\/loc>/);
  assert.doesNotMatch(xml, /<lastmod>/);
});

test("renderSitemapXml: ルートの lastmod には全記事の最大の updated_at を使う", () => {
  const xml = renderSitemapXml("https://blog.example.com", [
    { slug: "2026/11/25/120000", updated_at: "2026-11-25T03:00:00Z" },
    { slug: "2026/11/24/090000", updated_at: "2026-11-26T01:00:00Z" },
  ]);
  assert.match(xml, /<loc>https:\/\/blog\.example\.com\/<\/loc>\s*<lastmod>2026-11-26T01:00:00Z<\/lastmod>/);
});
