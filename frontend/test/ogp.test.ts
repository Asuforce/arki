import assert from "node:assert/strict";
import { test } from "node:test";
import { expandLinkCards, fetchOgp, isFetchable, parseOgp } from "../src/lib/ogp.ts";

const page = `<html><head><title>fallback</title>
<meta property="og:title" content="タイトル &amp; 副題">
<meta property="og:description" content="説明">
<meta property="og:image" content="/img/a.png">
<meta property="og:site_name" content="Site"></head><body></body></html>`;

const htmlFetch = (body: string): typeof fetch => async () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

test("OGP を読む", () => {
  const ogp = parseOgp(page, new URL("https://example.com/post/1"));
  assert.deepEqual(ogp, { title: "タイトル & 副題", description: "説明", image: "https://example.com/img/a.png", site: "Site" });
});

test("og:title が無ければ title を使う", () => {
  assert.equal(parseOgp("<head><title>T</title></head>", new URL("https://www.example.com/"))?.site, "example.com");
  assert.equal(parseOgp("<head></head>", new URL("https://example.com/")), null);
});

test("内部向けのアドレスは取りに行かない", () => {
  for (const u of ["http://localhost/", "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/", "http://[::1]/", "ftp://example.com/", "http://intranet/"]) {
    assert.equal(isFetchable(new URL(u)), false, u);
  }
  assert.equal(isFetchable(new URL("https://example.com/")), true);
});

test("ブログカードに OGP を入れる。取れなければそのまま", async () => {
  const html = '<a href="https://ok.example/a" class="link-card" rel="noopener noreferrer">https://ok.example/a</a><a href="https://ng.example/" class="link-card" rel="noopener noreferrer">https://ng.example/</a>';
  const fetcher: typeof fetch = async (input) =>
    String(input).startsWith("https://ok.example") ? htmlFetch(page)(input) : new Response("", { status: 404 });
  const out = await expandLinkCards(html, fetcher);
  assert.match(out, /class="link-card has-ogp"[^>]*><span class="link-card-body"><span class="link-card-title">タイトル &amp; 副題</);
  assert.match(out, /<img class="link-card-thumb" src="https:\/\/ok\.example\/img\/a\.png"/);
  assert.match(out, /<a href="https:\/\/ng\.example\/" class="link-card" rel="noopener noreferrer">https:\/\/ng\.example\/<\/a>/);
});

test("タイトルの HTML はエスケープする", async () => {
  const out = await expandLinkCards(
    '<a href="https://xss.example/" class="link-card" rel="noopener noreferrer">x</a>',
    htmlFetch('<head><meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;"></head>'),
  );
  assert.doesNotMatch(out, /<script/);
  assert.equal(await fetchOgp("http://127.0.0.1/", async () => assert.fail("fetch しない")), null);
});
