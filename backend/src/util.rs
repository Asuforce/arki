//! 純粋なロジック。Workers の API に依存しないので、手元の `cargo test` で確認できる。

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
/// Markdown の `![alt](url)` と HTML の `<img src>` を見る。コードブロックの中は飛ばす。
pub fn first_image_url(markdown: &str) -> Option<String> {
    let mut body = String::new();
    let mut in_fence = false;
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        } else if !in_fence {
            body.push_str(line);
            body.push('\n');
        }
    }
    // 小文字化しても ASCII だけなのでバイト位置は body と一致する
    let lower = body.to_ascii_lowercase();
    let mut from = 0;
    loop {
        let md = body[from..].find("![").map(|p| p + from);
        let html = lower[from..].find("<img").map(|p| p + from);
        let (start, is_html) = match (md, html) {
            (None, None) => return None,
            (Some(m), Some(h)) if h < m => (h, true),
            (Some(m), _) => (m, false),
            (None, Some(h)) => (h, true),
        };
        let url = if is_html {
            html_img_src(&body[start..], &lower[start..])
        } else {
            markdown_image_url(&body[start..])
        };
        if let Some(url) = url.filter(|u| is_thumbnail_url(u)) {
            return Some(url);
        }
        from = start + 1;
    }
}

/// `![alt](url "title")` の url。`s` は `![` から始まる。
fn markdown_image_url(s: &str) -> Option<String> {
    let rest = &s[s.find("](")? + 2..];
    let inner = &rest[..rest.find(')')?];
    inner.split_whitespace().next().map(str::to_string)
}

/// `<img ... src="url">` の url。`s` は `<img` から始まり、`lower` はその小文字版。
fn html_img_src(s: &str, lower: &str) -> Option<String> {
    let after = lower.as_bytes().get(4)?;
    if after.is_ascii_alphanumeric() {
        return None;
    }
    let end = s.find('>')?;
    let (tag, tag_lower) = (&s[..end], &lower[..end]);
    for (pos, _) in tag_lower.match_indices("src") {
        let preceded = tag.as_bytes()[pos - 1];
        if !(preceded.is_ascii_whitespace() || preceded == b'"' || preceded == b'\'') {
            continue;
        }
        let Some(value) = tag[pos + 3..].trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        return match value.chars().next()? {
            q @ ('"' | '\'') => value[1..].split(q).next().map(str::to_string),
            _ => value.split_whitespace().next().map(str::to_string),
        };
    }
    None
}

/// 絶対の http(s) か、サイト内の `/` 始まりのパスだけ通す。`//host` は別オリジンなので落とす。
fn is_thumbnail_url(url: &str) -> bool {
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
}
