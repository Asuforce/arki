//! 純粋なロジック。Workers の API に依存しないので、手元の `cargo test` で確認できる。

use pulldown_cmark::{Event, Options, Parser, Tag};

/// 1970-01-01 からの日数を (年, 月, 日) にする。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (年, 月, 日) を 1970-01-01 からの日数にする。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// エポック秒を `YYYY-MM-DDTHH:MM:SSZ`（UTC）にする。
pub fn epoch_to_iso(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// `YYYY-MM-DDTHH:MM:SSZ` をエポック秒にする。形式が違えば None。
pub fn iso_to_epoch(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se)
}

/// 公開日時（UTC）から、はてなと同じ JST の `YYYY/MM/DD/HHMMSS` を作る。
pub fn slug_from_published_at(iso: &str) -> Option<String> {
    let jst = epoch_to_iso(iso_to_epoch(iso)? + 9 * 3600);
    // 2019-11-23T03:13:44Z -> 2019/11/23/031344
    Some(format!(
        "{}/{}/{}/{}{}{}",
        &jst[0..4],
        &jst[5..7],
        &jst[8..10],
        &jst[11..13],
        &jst[14..16],
        &jst[17..19]
    ))
}

/// slug に使える文字だけか。パスをたどる `..` や先頭・末尾の `/` は不可。
pub fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 200
        && !slug.starts_with('/')
        && !slug.ends_with('/')
        && !slug.contains("//")
        && !slug.contains("..")
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_'))
}

/// 一覧用の抜粋。HTML タグと Markdown の記号を落とし、先頭 `max_chars` 文字にする。
pub fn make_excerpt(markdown: &str, max_chars: usize) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for line in markdown.lines() {
        let trimmed = line.trim();
        // ブログカードの <a> や ToC の目印だけの行は読めないので飛ばす
        if trimmed.starts_with("<!--")
            || trimmed.starts_with("```")
            || (trimmed.starts_with("<a href=") && trimmed.contains("link-card"))
        {
            continue;
        }
        let mut chars = trimmed.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                _ if in_tag => {}
                // ![alt](url) は丸ごと捨てる
                '!' if chars.peek() == Some(&'[') => {
                    for n in chars.by_ref() {
                        if n == ')' {
                            break;
                        }
                    }
                }
                // [text](url) は text だけ残す
                '[' => {
                    let mut label = String::new();
                    for n in chars.by_ref() {
                        if n == ']' {
                            break;
                        }
                        label.push(n);
                    }
                    if chars.peek() == Some(&'(') {
                        for n in chars.by_ref() {
                            if n == ')' {
                                break;
                            }
                        }
                    }
                    text.push_str(&label);
                }
                '#' | '*' | '`' | '>' | '|' => {}
                _ => text.push(c),
            }
        }
        text.push(' ');
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max_chars).collect()
}

/// 一覧のサムネイルにする、本文の最初の画像の URL。
/// 記事ページと同じく Markdown を CommonMark として読むので、コードや `\!` で打ち消した画像、
/// HTML コメントの中は対象にならない。HTML の `<img src>` は生の HTML からだけ読む。
pub fn first_image_url(markdown: &str) -> Option<String> {
    let mut html = String::new();
    for event in Parser::new_ext(markdown, Options::ENABLE_TABLES) {
        match event {
            Event::Html(text) | Event::InlineHtml(text) => html.push_str(&text),
            other => {
                if let Some(url) = take_html_img(&mut html) {
                    return Some(url);
                }
                if let Event::Start(Tag::Image { dest_url, .. }) = other {
                    if is_thumbnail_url(&dest_url) {
                        return Some(dest_url.into_string());
                    }
                }
            }
        }
    }
    take_html_img(&mut html)
}

/// 続いた HTML の断片から、通る URL の最初の `<img src>` を取り出し、断片を空にする。
fn take_html_img(html: &mut String) -> Option<String> {
    let url = html_img_srcs(html).find(|u| is_thumbnail_url(u));
    html.clear();
    url
}

/// HTML の中の `<img>` の `src` を、現れる順に返す。コメントは飛ばす。
/// 引用符の中の `>` でタグを閉じず、`data-src` や他の属性の値は `src` と見なさない。
fn html_img_srcs(html: &str) -> impl Iterator<Item = String> + '_ {
    let mut pos = 0;
    std::iter::from_fn(move || {
        while let Some(off) = html[pos..].find('<') {
            let start = pos + off;
            if html[start..].starts_with("<!--") {
                // `<!-->` と `<!--->` も空のコメントなので、`<!` の後ろから `-->` を探す
                let end = html[start + 2..].find("-->")?;
                pos = start + 2 + end + 3;
                continue;
            }
            let rest = &html.as_bytes()[start + 1..];
            if !rest.first().is_some_and(u8::is_ascii_alphabetic) {
                pos = start + 1;
                continue;
            }
            let name_len = rest
                .iter()
                .position(|&b| b.is_ascii_whitespace() || b == b'/' || b == b'>')
                .unwrap_or(rest.len());
            let is_img = rest[..name_len].eq_ignore_ascii_case(b"img");
            let (end, src) = read_attributes(html, start + 1 + name_len, is_img)?;
            pos = end;
            if let Some(src) = src {
                return Some(src);
            }
        }
        None
    })
}

/// `from` から始まる属性を、タグを閉じる `>` まで読む。閉じる前に終わったら `None`。
/// 返すのは `>` の次の位置と、`want_src` のときの最初の `src` の値。
fn read_attributes(html: &str, from: usize, want_src: bool) -> Option<(usize, Option<String>)> {
    let b = html.as_bytes();
    let mut i = from;
    let mut src = None;
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        match *b.get(i)? {
            b'>' => return Some((i + 1, src)),
            b'=' => i += 1,
            _ => {}
        }
        let name_start = i;
        while i < b.len() && !(b[i].is_ascii_whitespace() || matches!(b[i], b'/' | b'>' | b'=')) {
            i += 1;
        }
        let name = &b[name_start..i];
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b.get(i) != Some(&b'=') {
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let (value_start, value_end) = match *b.get(i)? {
            q @ (b'"' | b'\'') => {
                let start = i + 1;
                let end = start + b[start..].iter().position(|&c| c == q)?;
                i = end + 1;
                (start, end)
            }
            _ => {
                let start = i;
                while i < b.len() && !(b[i].is_ascii_whitespace() || b[i] == b'>') {
                    i += 1;
                }
                (start, i)
            }
        };
        if want_src && src.is_none() && name.eq_ignore_ascii_case(b"src") {
            src = Some(html[value_start..value_end].replace("&amp;", "&"));
        }
    }
}

/// 記事ページが `img` の `src` として描画する URL だけ通す。
/// 絶対の http(s) か、サイト内の `/` 始まりのパスで、`//host` は通さない。
/// ブラウザは URL の改行や tab を取り除くので、空白と制御文字を含むものも落とす。
fn is_thumbnail_url(url: &str) -> bool {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || (url.starts_with('/') && !url.starts_with("//") && !url.starts_with("/\\"))
}

/// 時間一定で文字列を比べる（トークンの比較用）。
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (*a.get(i).unwrap_or(&0) ^ *b.get(i).unwrap_or(&0)) as usize;
    }
    diff == 0
}

/// タイトル検索の LIKE パターンにする。`%` `_` `\` は文字そのものとして扱う（`ESCAPE '\'` と組で使う）。
pub fn like_pattern(query: &str) -> String {
    let mut pattern = String::from("%");
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

/// 先頭のバイト列から画像の種類を決める。`Content-Type` は信用しない。SVG は対象外。
pub fn sniff_image(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageKind::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

/// アニメーションを持つ画像か。静止画への変換で動きが消えるので、持つ画像は変換せずそのまま置く。
/// GIF は 2 フレーム以上、PNG は最初の IDAT より前に acTL、WebP は VP8X のアニメーションフラグ。
/// 読み取れない GIF は、安全側に倒して持つ扱いにする。
pub fn is_animated(bytes: &[u8], kind: ImageKind) -> bool {
    match kind {
        ImageKind::Gif => gif_frames(bytes).is_none_or(|n| n > 1),
        ImageKind::Png => png_has_actl(bytes),
        ImageKind::Webp => bytes.len() > 20 && &bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0,
        ImageKind::Jpeg => false,
    }
}

fn png_has_actl(bytes: &[u8]) -> bool {
    let mut at = 8;
    while let Some(header) = bytes.get(at..at + 8) {
        let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        match &header[4..8] {
            b"acTL" => return true,
            b"IDAT" => return false,
            _ => at += 12 + len,
        }
    }
    false
}

/// GIF のブロックをたどってフレーム（画像記述子）の数を数える。壊れていれば `None`。
fn gif_frames(bytes: &[u8]) -> Option<usize> {
    let flags = *bytes.get(10)?;
    let mut at = 13
        + if flags & 0x80 != 0 {
            3 << ((flags & 7) + 1)
        } else {
            0
        };
    let mut frames = 0;
    loop {
        match *bytes.get(at)? {
            0x3B => return Some(frames),
            0x21 => at = skip_sub_blocks(bytes, at + 2)?,
            0x2C => {
                let local = *bytes.get(at + 9)?;
                at += 10
                    + if local & 0x80 != 0 {
                        3 << ((local & 7) + 1)
                    } else {
                        0
                    };
                at = skip_sub_blocks(bytes, at + 1)?;
                frames += 1;
            }
            _ => return None,
        }
    }
}

fn skip_sub_blocks(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = *bytes.get(at)? as usize;
        at += 1 + len;
        if len == 0 {
            return Some(at);
        }
    }
}

/// 変換後の `Content-Type` に合う拡張子。
pub fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/avif" => Some("avif"),
        "image/webp" => Some("webp"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// R2 のキー。`now_iso` の年月で分け、`hash` は元の画像の内容から作った値。
pub fn image_key(now_iso: &str, hash: &str, extension: &str) -> String {
    format!(
        "uploads/{}/{}/{hash}.{extension}",
        &now_iso[0..4],
        &now_iso[5..7]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_round_trip() {
        assert_eq!(epoch_to_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_to_epoch("2019-11-22T18:13:44Z"), Some(1_574_446_424));
        assert_eq!(epoch_to_iso(1_574_446_424), "2019-11-22T18:13:44Z");
        assert_eq!(
            iso_to_epoch("2024-02-29T23:59:59Z")
                .map(epoch_to_iso)
                .as_deref(),
            Some("2024-02-29T23:59:59Z")
        );
    }

    #[test]
    fn iso_rejects_bad_input() {
        assert_eq!(iso_to_epoch("2019-11-22 18:13:44"), None);
        assert_eq!(iso_to_epoch("2019-13-22T18:13:44Z"), None);
        assert_eq!(iso_to_epoch("2019-11-22T25:13:44Z"), None);
        assert_eq!(iso_to_epoch(""), None);
    }

    #[test]
    fn slug_is_jst() {
        // はてなの 2019/11/23/031344（JST）は UTC では 11/22 18:13:44
        assert_eq!(
            slug_from_published_at("2019-11-22T18:13:44Z").as_deref(),
            Some("2019/11/23/031344")
        );
        // 年またぎ
        assert_eq!(
            slug_from_published_at("2020-12-31T15:00:00Z").as_deref(),
            Some("2021/01/01/000000")
        );
    }

    #[test]
    fn slug_validation() {
        assert!(is_valid_slug("2019/11/23/031344"));
        assert!(is_valid_slug("2023/05/19/000100_1"));
        assert!(is_valid_slug("hello-world"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("/a"));
        assert!(!is_valid_slug("a/"));
        assert!(!is_valid_slug("a/../b"));
        assert!(!is_valid_slug("a b"));
        assert!(!is_valid_slug("日本語"));
    }

    #[test]
    fn excerpt_strips_markup() {
        let md = "### TL;DR\n\n- **SW** JFO\n\n![](https://example.com/a.jpg)\n\n[リンク](https://example.com) です\n<!-- toc -->\n<a href=\"x\">card</a>";
        assert_eq!(make_excerpt(md, 100), "TL;DR - SW JFO リンク です card");
        assert_eq!(make_excerpt("あいうえお", 3), "あいう");
    }

    #[test]
    fn thumbnail_takes_first_image() {
        let md = "![a](https://example.com/1.jpg)\n\n![b](https://example.com/2.jpg)";
        assert_eq!(
            first_image_url(md).as_deref(),
            Some("https://example.com/1.jpg")
        );
        assert_eq!(
            first_image_url("![](/img/a.png)").as_deref(),
            Some("/img/a.png")
        );
    }

    #[test]
    fn thumbnail_after_text() {
        let md = "# 見出し\n\n本文 [リンク](https://example.com) です。\n\n![x](https://example.com/p.png)";
        assert_eq!(
            first_image_url(md).as_deref(),
            Some("https://example.com/p.png")
        );
    }

    #[test]
    fn thumbnail_trims_title() {
        assert_eq!(
            first_image_url("![a]( https://example.com/p.png \"タイトル\" )").as_deref(),
            Some("https://example.com/p.png")
        );
    }

    #[test]
    fn thumbnail_from_html_img() {
        let md =
            "text\n<img class=\"a\" data-src=\"/no.png\" src='https://example.com/h.png' alt=\"\">";
        assert_eq!(
            first_image_url(md).as_deref(),
            Some("https://example.com/h.png")
        );
        assert_eq!(
            first_image_url("<IMG\nsrc=\"/a.png\">").as_deref(),
            Some("/a.png")
        );
        assert_eq!(first_image_url("<imgx src=\"/a.png\">"), None);
        assert_eq!(
            first_image_url("<img alt=\"src\" src=\"/a.png\">").as_deref(),
            Some("/a.png")
        );
    }

    #[test]
    fn thumbnail_orders_markdown_and_html() {
        let md = "<img src=\"/html.png\"> ![m](/md.png)";
        assert_eq!(first_image_url(md).as_deref(), Some("/html.png"));
    }

    #[test]
    fn thumbnail_ignores_code_fence() {
        let md = "```md\n![x](https://example.com/in-code.png)\n```\n\n![y](https://example.com/out.png)";
        assert_eq!(
            first_image_url(md).as_deref(),
            Some("https://example.com/out.png")
        );
        assert_eq!(first_image_url("```\n![x](/a.png)\n```"), None);
    }

    #[test]
    fn thumbnail_rejects_bad_scheme() {
        assert_eq!(first_image_url("![x](javascript:alert(1))"), None);
        assert_eq!(first_image_url("![x](data:image/png;base64,AAAA)"), None);
        assert_eq!(first_image_url("<img src=\"javascript:alert(1)\">"), None);
        assert_eq!(first_image_url("![x](//evil.example/a.png)"), None);
        assert_eq!(first_image_url("![x](a.png)"), None);
        assert_eq!(
            first_image_url("![x](data:image/png;base64,AAAA)\n![y](/ok.png)").as_deref(),
            Some("/ok.png")
        );
    }

    #[test]
    fn thumbnail_unclosed_marker_does_not_borrow_later_link() {
        assert_eq!(
            first_image_url("Use ![ for images. See [docs](https://example.com/page)"),
            None
        );
        assert_eq!(
            first_image_url("![logo][ref]\n\n[home](https://example.com/)"),
            None
        );
        assert_eq!(
            first_image_url("![logo][ref]\n\n[ref]: /logo.png").as_deref(),
            Some("/logo.png")
        );
    }

    #[test]
    fn thumbnail_skips_code() {
        let after = "\n\n![y](/out.png)";
        for code in [
            "`![x](/in.png)`",
            "~~~\n![x](/in.png)\n~~~",
            "    ![x](/in.png)",
            "````\n```\n![x](/in.png)\n```\n````",
            "<!-- ![x](/in.png) -->",
        ] {
            assert_eq!(
                first_image_url(&format!("{code}{after}")).as_deref(),
                Some("/out.png"),
                "{code}"
            );
            assert_eq!(first_image_url(code), None, "{code}");
        }
    }

    #[test]
    fn thumbnail_skips_commented_html() {
        let out = "<img src=\"/out.png\">";
        for comment in [
            "<!-- <img src=\"/in.png\"> -->",
            "<!--\n<img src=\"/in.png\">\n-->",
            "text <!-- <img src=\"/in.png\"> --> text",
            "<!--\nnote\n-->\n<!-- <img src=\"/in.png\"> -->",
        ] {
            assert_eq!(first_image_url(comment), None, "{comment}");
            assert_eq!(
                first_image_url(&format!("{comment}\n\n{out}")).as_deref(),
                Some("/out.png"),
                "{comment}"
            );
        }
    }

    #[test]
    fn thumbnail_skips_escaped_marker() {
        assert_eq!(first_image_url("\\![x](/a.png)"), None);
    }

    #[test]
    fn thumbnail_keeps_parentheses_in_url() {
        assert_eq!(
            first_image_url("![x](https://en.wikipedia.org/wiki/Foo_(bar).png)").as_deref(),
            Some("https://en.wikipedia.org/wiki/Foo_(bar).png")
        );
    }

    #[test]
    fn thumbnail_rejects_whitespace_and_control_chars() {
        for url in [
            "/\n/evil.example/a.png",
            "/\t/evil.example/a.png",
            "/a\u{0}.png",
            "/a b.png",
        ] {
            assert!(!is_thumbnail_url(url), "{url:?}");
            assert_eq!(
                first_image_url(&format!("<img src=\"{url}\">")),
                None,
                "{url:?}"
            );
        }
        assert_eq!(
            first_image_url("<img src=\"/\n/evil.example/a.png\"> ![y](/ok.png)").as_deref(),
            Some("/ok.png")
        );
    }

    #[test]
    fn thumbnail_html_attributes_are_read_per_tag() {
        let cases = [
            ("<img alt=\"a>b\" src=\"/a.png\">", Some("/a.png")),
            ("<img data-src=\"/no.png\" src=\"/a.png\">", Some("/a.png")),
            ("<img data-src=\"/no.png\">", None),
            ("<img alt=\"a src=/no.png\">", None),
            ("<img alt='x' src=/a.png>", Some("/a.png")),
            (
                "<a title=\"<img src='/no.png'>\"><img src=\"/a.png\"></a>",
                Some("/a.png"),
            ),
            ("<div>\n<img src=\"/a.png\">\n</div>", Some("/a.png")),
            ("<img src=\"/a.png", None),
            ("<img src=\"/a.png?x=1&amp;y=2\">", Some("/a.png?x=1&y=2")),
        ];
        for (md, want) in cases {
            assert_eq!(first_image_url(md).as_deref(), want, "{md}");
        }
    }

    #[test]
    fn thumbnail_scales_linearly() {
        let start = std::time::Instant::now();
        assert_eq!(first_image_url(&"![".repeat(50_000)), None);
        assert_eq!(first_image_url(&"<img ".repeat(50_000)), None);
        assert_eq!(
            first_image_url(&format!("<div>\n{}", "<img ".repeat(50_000))),
            None
        );
        assert_eq!(first_image_url(&"<!-- ".repeat(50_000)), None);
        assert!(start.elapsed().as_secs_f64() < 2.0, "{:?}", start.elapsed());
    }

    #[test]
    fn thumbnail_none_without_image() {
        assert_eq!(first_image_url(""), None);
        assert_eq!(
            first_image_url("画像なし [リンク](https://example.com)"),
            None
        );
        assert_eq!(first_image_url("![壊れた](https://example.com/a.png"), None);
    }

    #[test]
    fn token_compare() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("日記"), "%日記%");
        assert_eq!(like_pattern("100%_a\\b"), "%100\\%\\_a\\\\b%");
    }

    #[test]
    fn sniff_ignores_declared_type_and_rejects_svg() {
        assert_eq!(
            sniff_image(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]),
            Some(ImageKind::Png)
        );
        assert_eq!(
            sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(ImageKind::Jpeg)
        );
        assert_eq!(sniff_image(b"GIF89a\x01\x00"), Some(ImageKind::Gif));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageKind::Webp));
        assert_eq!(
            sniff_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            None
        );
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_image(b""), None);
    }

    const GIF_HEADER: &[u8] = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff";
    const GIF_FRAME: &[u8] =
        b"!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00";

    fn gif(frames: usize) -> Vec<u8> {
        let mut bytes = GIF_HEADER.to_vec();
        for _ in 0..frames {
            bytes.extend(GIF_FRAME);
        }
        bytes.push(b';');
        bytes
    }

    #[test]
    fn gif_is_animated_only_with_several_frames() {
        assert!(!is_animated(&gif(1), ImageKind::Gif));
        assert!(is_animated(&gif(2), ImageKind::Gif));
        assert!(
            is_animated(&gif(1)[..20], ImageKind::Gif),
            "truncated counts as animated"
        );
    }

    const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    fn chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
        let mut bytes = (data.len() as u32).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(data);
        bytes.extend([0; 4]);
        bytes
    }

    #[test]
    fn png_animation_is_read_from_chunks_not_bytes() {
        let apng = [
            PNG_SIGNATURE,
            &chunk(b"acTL", &[0; 8]),
            &chunk(b"IDAT", &[]),
        ]
        .concat();
        assert!(is_animated(&apng, ImageKind::Png));
        let still = [
            PNG_SIGNATURE,
            &chunk(b"IDAT", &[]),
            &chunk(b"acTL", &[0; 8]),
        ]
        .concat();
        assert!(!is_animated(&still, ImageKind::Png));
        let lookalike = [
            PNG_SIGNATURE,
            &chunk(b"iCCP", b"acTL"),
            &chunk(b"IDAT", &[]),
        ]
        .concat();
        assert!(!is_animated(&lookalike, ImageKind::Png));
    }

    #[test]
    fn webp_and_jpeg_animation() {
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
        webp.extend([0x02, 0, 0, 0]);
        assert!(is_animated(&webp, ImageKind::Webp));
        webp[20] = 0x10;
        assert!(!is_animated(&webp, ImageKind::Webp));
        assert!(!is_animated(&[0xFF, 0xD8, 0xFF], ImageKind::Jpeg));
    }

    #[test]
    fn image_key_and_extension() {
        assert_eq!(
            image_key("2026-10-12T13:12:58Z", "0123456789abcdef", "avif"),
            "uploads/2026/10/0123456789abcdef.avif"
        );
        assert_eq!(image_extension("image/avif"), Some("avif"));
        assert_eq!(image_extension("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension("image/svg+xml"), None);
    }
}
