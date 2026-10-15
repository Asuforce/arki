import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPost } from "../src/lib/render.ts";

test("Markdown を HTML にする", () => {
  assert.match(renderPost("# 見出し\n\n本文 **強調**"), /<h1 id="h-1">見出し<\/h1>[\s\S]*<strong>強調<\/strong>/);
});

test("script と on* 属性と javascript: を落とす", () => {
  const html = renderPost('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[a](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|onerror|javascript:/);
});

test("iframe は許可したホストだけ", () => {
  const ok = renderPost('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
  assert.match(ok, /<iframe src="https:\/\/www\.youtube\.com\/embed\/abc"/);
  assert.doesNotMatch(renderPost('<iframe src="https://evil.example/x"></iframe>'), /<iframe/);
});

test("画像は lazy にし、外部リンクには rel を付ける", () => {
  const html = renderPost("![](https://example.com/a.jpg)\n\n[x](https://example.com)\n\n[y](/entry/2019/01/01/000000)");
  assert.match(html, /<img[^>]*loading="lazy"/);
  assert.match(html, /<a href="https:\/\/example\.com" rel="noopener noreferrer">x<\/a>/);
  assert.match(html, /<a href="\/entry\/2019\/01\/01\/000000">y<\/a>/);
});

test("ブログカードの class を残す", () => {
  const html = renderPost('<a href="https://example.com/a" class="link-card">https://example.com/a</a>');
  assert.match(html, /class="link-card"/);
});

test("目次の目印を h2/h3 の一覧にする", () => {
  const html = renderPost("<!-- toc -->\n\n## 一\n\n### 二\n\n#### 三\n");
  assert.match(html, /<nav class="toc">/);
  assert.match(html, /<a href="#h-1">一<\/a>/);
  assert.match(html, /<a href="#h-2">二<\/a>/);
  assert.doesNotMatch(html, /href="#h-3"/);
  assert.match(html, /<h2 id="h-1">一<\/h2>/);
});

test("目次の目印が無ければ目次を出さない", () => {
  assert.doesNotMatch(renderPost("## 一"), /class="toc"/);
});

test("YouTube の URL だけの段落を埋め込みにする", () => {
  for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ"]) {
    const html = renderPost(`前\n\n${url}\n\n後`);
    assert.match(html, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/, url);
  }
  assert.match(renderPost("https://youtu.be/dQw4w9WgXcQ?t=1m30s"), /embed\/dQw4w9WgXcQ\?start=90/);
  assert.match(renderPost("[https://youtu.be/dQw4w9WgXcQ](https://youtu.be/dQw4w9WgXcQ)"), /<iframe/);
});

test("文章の途中の YouTube リンクと、名前つきリンクは埋め込まない", () => {
  assert.doesNotMatch(renderPost("これ https://youtu.be/dQw4w9WgXcQ を見て"), /<iframe/);
  assert.doesNotMatch(renderPost("[この動画](https://youtu.be/dQw4w9WgXcQ)"), /<iframe/);
});

test("X の投稿 URL だけの段落を埋め込みにする", () => {
  const html = renderPost("https://x.com/jack/status/20?s=20");
  assert.match(html, /<blockquote class="twitter-tweet" data-dnt="true"><a href="https:\/\/twitter\.com\/jack\/status\/20"/);
  assert.doesNotMatch(renderPost("https://x.com/jack"), /twitter-tweet/);
});

test("URL だけの段落はブログカードにし、相対リンクは触らない", () => {
  assert.match(renderPost("https://example.com/a?x=1&y=2"), /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2" class="link-card" rel="noopener noreferrer">/);
  assert.doesNotMatch(renderPost("[/entry/2019/01/01/000000](/entry/2019/01/01/000000)"), /link-card/);
});

test("X の blockquote 埋め込みは class を残し、他の class は落とす", () => {
  const html = renderPost('<blockquote class="twitter-tweet evil"><p>本文</p>&mdash; a <a href="https://twitter.com/a/status/1">May 1, 2020</a></blockquote>');
  assert.match(html, /<blockquote class="twitter-tweet">/);
  assert.doesNotMatch(renderPost('<blockquote class="evil">x</blockquote>'), /class=/);
});
