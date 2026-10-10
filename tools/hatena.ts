/** はてな記法・はてな固有の HTML を、標準の Markdown / HTML に直す。 */

export interface ConvertOptions {
  /** 旧ブログのホスト名（例: example.hatenablog.com）。この host への記事リンクを相対パスにする。 */
  oldHost?: string;
  /** 画像 URL の置き換え表（はてなの URL -> 新しい URL）。 */
  imageMap?: Record<string, string>;
}

export interface ConvertResult {
  content: string;
  /** 変換できずに残ったはてな記法らしきもの。手で確認する。 */
  unknown: string[];
}

const FOTOLIFE_EXT: Record<string, string> = { j: "jpg", p: "png", g: "gif" };

/** `[f:id:user:20200531145634j:plain]` の部分から画像 URL を作る。 */
export function fotolifeUrl(user: string, date: string, time: string, ext: string): string | null {
  const e = FOTOLIFE_EXT[ext];
  if (!e) return null;
  return `https://cdn-ak.f.st-hatena.com/images/fotolife/${user[0]}/${user}/${date}/${date}${time}.${e}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** コードブロックの中は触らず、外側だけ `fn` で変換する。 */
function mapOutsideCode(body: string, fn: (s: string) => string): string {
  const parts = body.split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$)/m);
  // split で括弧を使うと、奇数番目がコードブロックになる
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join("");
}

export function convertBody(body: string, options: ConvertOptions = {}): ConvertResult {
  const mapImage = (url: string): string => options.imageMap?.[url] ?? url;

  const convert = (src: string): string => {
    let s = src;

    // 旧ブログ内の記事リンクを相対パスにする（先にやる。以降の変換が相対パスも扱う）
    if (options.oldHost) {
      s = s.replace(new RegExp(`https?://${escapeRegExp(options.oldHost)}(?=/entry/)`, "g"), "");
    }

    // はてなフォトライフ: <span ...Photograph...><img src="..."></span>
    s = s.replace(
      /<span[^>]*schema\.org\/Photograph[^>]*>\s*<img\b[^>]*?\bsrc="([^"]+)"[^>]*>\s*<\/span>/g,
      (_m, url: string) => `![](${mapImage(url)})`,
    );

    // [f:id:user:20200531145634j:plain]
    s = s.replace(/\[f:id:([A-Za-z0-9_-]+):(\d{8})(\d{6})([a-z])(?::[A-Za-z]+)*\]/g, (m, user, date, time, ext) => {
      const url = fotolifeUrl(user, date, time, ext);
      return url ? `![](${mapImage(url)})` : m;
    });

    // はてなブログカードの iframe -> 普通のリンク
    s = s.replace(
      /<iframe\b[^>]*?src="(?:https:)?\/\/hatenablog-parts\.com\/embed\?url=([^"&]+)[^"]*"[^>]*>\s*<\/iframe>/g,
      (full, enc: string) => {
        let url: string;
        try {
          url = decodeURIComponent(enc);
        } catch {
          return full;
        }
        if (options.oldHost) {
          url = url.replace(new RegExp(`^https?://${escapeRegExp(options.oldHost)}(?=/entry/)`), "");
        }
        const title = /\btitle="([^"]*)"/.exec(full)?.[1];
        return `[${title ? title.replace(/[\[\]]/g, "") : url}](${url})`;
      },
    );

    // [URL:embed:cite] -> ブログカード用のリンク
    s = s.replace(
      /\[((?:https?:\/\/|\/)[^\]\s]+?):embed:cite\]/g,
      (_m, url: string) => `<a href="${url}" class="link-card">${url}</a>`,
    );

    // [URL:embed#コメント] / [URL:embed] -> コメントを引用にして、リンクを付ける
    s = s.replace(/\[(https?:\/\/[^\]\s]+?):embed(?:#([^\]]*))?\]/g, (_m, url: string, comment?: string) => {
      const link = `[${url}](${url})`;
      const text = comment?.trim();
      return text ? `> ${text.replace(/\n+/g, " ")}\n\n${link}` : link;
    });

    // [URL:title] / [URL:title=テキスト]
    s = s.replace(
      /\[((?:https?:\/\/|\/)[^\]\s]+?):title(?:=([^\]]*))?\]/g,
      (_m, url: string, text?: string) => `[${text?.trim() || url}](${url})`,
    );

    // [asin:4822289605:detail]
    s = s.replace(
      /\[asin:([0-9A-Za-z]{10}):[a-z]+\]/g,
      (_m, asin: string) => `[Amazon](https://www.amazon.co.jp/dp/${asin})`,
    );

    s = s.replace(/^\[:contents\][ \t]*$/gm, "<!-- toc -->");
    s = s.replace(/\[:contents\]/g, "\n\n<!-- toc -->\n\n"); // 行の途中に書かれたもの
    s = s.replace(/<!--\s*more\s*-->\n?/g, "");

    // 画像タグそのもの（フォトライフ以外で貼られたもの）にも置き換え表を使う
    s = s.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (_m, a: string, url: string, b: string) => a + mapImage(url) + b);

    return s;
  };

  const content = mapOutsideCode(body, convert);

  const unknown = new Set<string>();
  const leftovers = /\[f:id:[^\]]*\]|\[[^\]\s]*:(?:embed|title|detail|image)[^\]]*\]|\[(?:asin|map|tex|graph|twitter|amazon):[^\]]*\]|\[:[a-z]+\]/g;
  mapOutsideCode(content, (s) => {
    for (const m of s.matchAll(leftovers)) unknown.add(m[0].slice(0, 80));
    return s;
  });

  return { content, unknown: [...unknown] };
}

/** 本文に残っているはてなの画像 URL（移行対象）を集める。 */
export function collectHatenaImages(content: string): string[] {
  const urls = new Set<string>();
  for (const m of content.matchAll(/https:\/\/cdn-ak\.f\.st-hatena\.com\/[^\s"')>]+/g)) urls.add(m[0]);
  return [...urls];
}
