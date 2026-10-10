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
    fn token_compare() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
    }
}
