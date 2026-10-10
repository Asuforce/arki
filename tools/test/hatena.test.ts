import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHatenaImages, convertBody, fotolifeUrl } from "../hatena.ts";
import { makeExcerpt, slugFromDate, toUtcIso } from "../text.ts";

const convert = (s: string, o = {}) => convertBody(s, o).content;

test("フォトライフの記法を画像にする", () => {
  assert.equal(
    convert("[f:id:someuser:20200531145634j:plain]"),
    "![](https://cdn-ak.f.st-hatena.com/images/fotolife/s/someuser/20200531/20200531145634.jpg)",
  );
  assert.equal(
    convert("[f:id:someuser:20200531145634p:plain]"),
    "![](https://cdn-ak.f.st-hatena.com/images/fotolife/s/someuser/20200531/20200531145634.png)",
  );
  assert.equal(fotolifeUrl("u", "20200101", "000000", "x"), null);
});

test("フォトライフの span + img を画像にする", () => {
  const html =
    '<span itemtype="http://schema.org/Photograph" itemscope="itemscope"><img class="magnifiable" src="https://cdn-ak.f.st-hatena.com/images/fotolife/a/u/20200807/20200807134842.jpg" itemprop="image"></span>';
  assert.equal(convert(html), "![](https://cdn-ak.f.st-hatena.com/images/fotolife/a/u/20200807/20200807134842.jpg)");
});

test("画像の置き換え表を使う", () => {
  const from = "https://cdn-ak.f.st-hatena.com/images/fotolife/s/someuser/20200531/20200531145634.jpg";
  const out = convert("[f:id:someuser:20200531145634j:plain]", { imageMap: { [from]: "https://img.example/x.jpg" } });
  assert.equal(out, "![](https://img.example/x.jpg)");
  assert.equal(
    convert(`<img src="${from}" alt="a">`, { imageMap: { [from]: "https://img.example/x.jpg" } }),
    '<img src="https://img.example/x.jpg" alt="a">',
  );
});

test("ブログカード", () => {
  assert.equal(
    convert("[https://example.com/a:embed:cite]"),
    '<a href="https://example.com/a" class="link-card">https://example.com/a</a>',
  );
});

test("Twitter 埋め込みはリンクにし、コメントは引用にする", () => {
  assert.equal(convert("[https://twitter.com/u/status/1:embed]"), "[https://twitter.com/u/status/1](https://twitter.com/u/status/1)");
  assert.equal(
    convert("[https://twitter.com/u/status/1:embed#こんにちは]"),
    "> こんにちは\n\n[https://twitter.com/u/status/1](https://twitter.com/u/status/1)",
  );
});

test(":title と asin", () => {
  assert.equal(convert("[https://example.com/:title]"), "[https://example.com/](https://example.com/)");
  assert.equal(convert("[https://example.com/:title=見出し]"), "[見出し](https://example.com/)");
  assert.equal(convert("[asin:4822289605:detail]"), "[Amazon](https://www.amazon.co.jp/dp/4822289605)");
});

test("目次と more", () => {
  assert.equal(convert("a\n\n[:contents]\n\nb"), "a\n\n<!-- toc -->\n\nb");
  assert.match(convert("9[:contents]\n\nb"), /^9\n\n<!-- toc -->\n+b$/);
  assert.equal(convert("a\n<!-- more -->\nb"), "a\nb");
});

test("旧ブログへのリンクを相対パスにする", () => {
  const o = { oldHost: "old.hatenablog.com" };
  assert.equal(convert("[x](https://old.hatenablog.com/entry/2019/11/12/015301)", o), "[x](/entry/2019/11/12/015301)");
  assert.equal(
    convert("[https://old.hatenablog.com/entry/2019/11/12/015301:embed:cite]", o),
    '<a href="/entry/2019/11/12/015301" class="link-card">/entry/2019/11/12/015301</a>',
  );
  assert.equal(convert("https://other.example/entry/1", o), "https://other.example/entry/1");
});

test("hatenablog-parts の iframe を普通のリンクにする", () => {
  const html =
    '<iframe class="embed-card" title="記事 [1]" src="https://hatenablog-parts.com/embed?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1" frameborder="0"></iframe>';
  assert.equal(convert(html), "[記事 1](https://example.com/a?b=1)");
  const rel = '<iframe src="//hatenablog-parts.com/embed?url=http%3A%2F%2Fexample.com%2F"></iframe>';
  assert.equal(convert(rel), "[http://example.com/](http://example.com/)");
});

test("YouTube の iframe はそのまま残す", () => {
  const html = '<iframe width="560" src="https://www.youtube.com/embed/abc"></iframe>';
  assert.equal(convert(html), html);
});

test("コードブロックの中は変換しない", () => {
  const md = "```\n[f:id:u:20200101000000j:plain]\n[:contents]\n```\n\n[:contents]";
  assert.equal(convert(md), "```\n[f:id:u:20200101000000j:plain]\n[:contents]\n```\n\n<!-- toc -->");
});

test("変換できなかった記法を知らせる", () => {
  const r = convertBody("[unknown:embed:foo]\n\n[asin:xyz:detail]");
  assert.ok(r.unknown.length >= 1);
  assert.deepEqual(convertBody("普通の文章です").unknown, []);
});

test("はてなの画像 URL を集める", () => {
  const c = "![](https://cdn-ak.f.st-hatena.com/images/fotolife/a/u/1/1.jpg) text ![](https://example.com/b.png) ![](https://cdn-ak.f.st-hatena.com/images/fotolife/a/u/1/1.jpg)";
  assert.deepEqual(collectHatenaImages(c), ["https://cdn-ak.f.st-hatena.com/images/fotolife/a/u/1/1.jpg"]);
});

test("抜粋は backend と同じ規則", () => {
  const md =
    "### TL;DR\n\n- **SW** JFO\n\n![](https://example.com/a.jpg)\n\n[リンク](https://example.com) です\n<!-- toc -->\n<a href=\"x\">card</a>";
  assert.equal(makeExcerpt(md, 100), "TL;DR - SW JFO リンク です card");
  assert.equal(makeExcerpt("あいうえお", 3), "あいう");
  assert.equal(makeExcerpt('<a href="x" class="link-card">x</a>\nhello'), "hello");
});

test("slug は JST", () => {
  assert.equal(slugFromDate(new Date("2019-11-22T18:13:44Z")), "2019/11/23/031344");
  assert.equal(slugFromDate(new Date("2020-12-31T15:00:00Z")), "2021/01/01/000000");
  assert.equal(toUtcIso(new Date("2019-11-23T03:13:44+09:00")), "2019-11-22T18:13:44Z");
});
