//! 記事のティア判定の規則。入出力を持たない純関数だけを置く。

use crate::util::make_excerpt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 長さの門。表示される文字がこの数以上なら `Gate::Long`。
pub const LENGTH_GATE: usize = 500;
pub const DEFAULT_THRESHOLD: f64 = 0.65;
pub const DEFAULT_MODEL: &str = "@cf/cloudflare/clef-flash";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Long = 1,
    Knowledge = 2,
    Diary = 3,
}

impl Tier {
    pub fn number(self) -> i64 {
        self as i64
    }
}

/// 長さの門のどちら側か。Clef に出す 2 択と、ナレッジでないときの行き先を決める。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Gate {
    /// 門を超えた。選べるのは長文とナレッジ。
    Long,
    /// 門を超えない。選べるのはナレッジと日記。
    Short,
}

/// Clef に渡す 2 択の、ナレッジか、もう一方か。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Knowledge,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Verdict {
    pub tier: Tier,
    /// Clef が選んだ選択肢と、最終の tier が違う。
    pub fallback: bool,
}

impl Gate {
    pub fn of(length: usize) -> Gate {
        if length >= LENGTH_GATE {
            Gate::Long
        } else {
            Gate::Short
        }
    }

    /// ナレッジでないときの tier。
    pub fn other_tier(self) -> Tier {
        match self {
            Gate::Long => Tier::Long,
            Gate::Short => Tier::Diary,
        }
    }

    /// Clef の選択肢のキー。ナレッジ以外の側。
    pub fn other_key(self) -> &'static str {
        match self {
            Gate::Long => "long",
            Gate::Short => "diary",
        }
    }

    pub const KNOWLEDGE_KEY: &'static str = "knowledge";

    pub fn pick_of(self, key: &str) -> Option<Pick> {
        if key == Self::KNOWLEDGE_KEY {
            Some(Pick::Knowledge)
        } else if key == self.other_key() {
            Some(Pick::Other)
        } else {
            None
        }
    }

    pub fn instructions(self) -> &'static str {
        "この記事の性格として最も近いものを選ぶ"
    }

    pub fn knowledge_description(self) -> &'static str {
        match self {
            Gate::Long => "再利用できる手順や設定を、まとめて記録している",
            Gate::Short => "再利用できる手順、設定、エラーの解決、学びがある",
        }
    }

    pub fn other_description(self) -> &'static str {
        match self {
            Gate::Long => "考察、検証、設計の考え、体験を、自分の言葉で掘り下げている",
            Gate::Short => "感想や出来事が中心で、再利用できる知見がない",
        }
    }
}

/// ナレッジは、Clef がナレッジを選び、confidence が閾値以上のときだけ付ける。
pub fn decide(gate: Gate, pick: Pick, confidence: f64, threshold: f64) -> Verdict {
    match pick {
        Pick::Knowledge if confidence >= threshold => Verdict {
            tier: Tier::Knowledge,
            fallback: false,
        },
        Pick::Knowledge => Verdict {
            tier: gate.other_tier(),
            fallback: true,
        },
        Pick::Other => Verdict {
            tier: gate.other_tier(),
            fallback: false,
        },
    }
}

/// 分岐ごとの閾値。2 つの分岐は選択肢の組が違い、confidence の尺度も同じとは限らない。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    pub long: f64,
    pub short: f64,
}

impl Thresholds {
    pub fn of(self, gate: Gate) -> f64 {
        match gate {
            Gate::Long => self.long,
            Gate::Short => self.short,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TierConfig {
    pub model: String,
    pub thresholds: Thresholds,
}

impl TierConfig {
    /// 設定値の文字列から作る。未設定は既定値で、範囲外や数でない閾値は誤りにする。
    pub fn parse(
        model: Option<&str>,
        long: Option<&str>,
        short: Option<&str>,
    ) -> Result<TierConfig, String> {
        let threshold = |name: &str, raw: Option<&str>| -> Result<f64, String> {
            let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
                return Ok(DEFAULT_THRESHOLD);
            };
            match raw.parse::<f64>() {
                Ok(v) if (0.0..=1.0).contains(&v) => Ok(v),
                _ => Err(format!("{name} must be a number between 0 and 1")),
            }
        };
        Ok(TierConfig {
            model: model
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_MODEL)
                .to_string(),
            thresholds: Thresholds {
                long: threshold("TIER_THRESHOLD_LONG", long)?,
                short: threshold("TIER_THRESHOLD_SHORT", short)?,
            },
        })
    }
}

// ---- 長さ ----------------------------------------------------------------

/// 読者に見える文字の数（Unicode のコードポイント）。
/// タグ、画像、リンクの URL、記号の除去は `make_excerpt` に任せ、ここでは
/// 複数行にまたがる HTML コメントと、本文中の裸の URL を足して除く。
/// コードブロックの中身は数える。
pub fn visible_length(markdown: &str) -> usize {
    let without_comments = strip_html_comments(markdown);
    let text = make_excerpt(&without_comments, usize::MAX);
    strip_bare_urls(&text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .count()
}

fn strip_html_comments(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start + 4..].find("-->") {
            Some(end) => rest = &rest[start + 4 + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn is_url_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c)
}

/// `http(s)://` から、URL に使える ASCII の文字が続く間を除く。日本語の文字で止まる。
fn strip_bare_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let found = ["https://", "http://"]
            .iter()
            .filter_map(|p| rest.find(p))
            .min();
        let Some(start) = found else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail
            .char_indices()
            .find(|(_, c)| !is_url_char(*c))
            .map_or(tail.len(), |(i, _)| i);
        rest = &tail[end..];
    }
}

// ---- Clef に渡す入力 -------------------------------------------------------

pub fn clef_state(title: &str, categories: &[String], content: &str) -> String {
    format!("{title}\n{}\n\n{content}", categories.join(", "))
}

// ---- PATCH /api/posts/:id/tier の本文 ------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierInput {
    tier: Option<i64>,
    tier_confidence: Option<f64>,
    source: Option<String>,
    tier_locked: Option<bool>,
}

/// 書き方は 3 通りだけ。
#[derive(Debug, PartialEq)]
pub enum TierWrite {
    /// 人が決めた。confidence を消してロックする。
    Manual { tier: Tier },
    /// バッチが決めた。ロックされていない行にだけ書く。
    Auto { tier: Tier, confidence: f64 },
    /// ロックを外す。tier と confidence はそのまま。
    Unlock,
}

pub fn tier_from_number(n: i64) -> Option<Tier> {
    match n {
        1 => Some(Tier::Long),
        2 => Some(Tier::Knowledge),
        3 => Some(Tier::Diary),
        _ => None,
    }
}

pub fn parse_tier_write(input: &TierInput) -> Result<TierWrite, &'static str> {
    if let Some(source) = &input.source {
        if source != "auto" {
            return Err("source must be 'auto' when given");
        }
    }
    match (input.tier, input.tier_locked) {
        (None, Some(false)) => {
            if input.tier_confidence.is_some() || input.source.is_some() {
                return Err("tier_locked: false takes no other field");
            }
            Ok(TierWrite::Unlock)
        }
        (None, Some(true)) => Err("tier_locked can only be set to false; give a tier to lock"),
        (None, None) => Err("give a tier or tier_locked: false"),
        (Some(_), Some(_)) => Err("tier and tier_locked cannot be given together"),
        (Some(n), None) => {
            let tier = tier_from_number(n).ok_or("tier must be 1, 2 or 3")?;
            match (input.source.is_some(), input.tier_confidence) {
                (false, None) => Ok(TierWrite::Manual { tier }),
                (false, Some(_)) => Err("tier_confidence needs source: 'auto'"),
                (true, None) => Err("source: 'auto' needs tier_confidence"),
                (true, Some(c)) if (0.0..=1.0).contains(&c) => Ok(TierWrite::Auto {
                    tier,
                    confidence: c,
                }),
                (true, Some(_)) => Err("tier_confidence must be between 0 and 1"),
            }
        }
    }
}

/// 公開の応答に出さない、記事のティアの状態。
#[derive(Debug, Clone, Serialize)]
pub struct TierState {
    pub tier: Option<i64>,
    pub tier_confidence: Option<f64>,
    pub tier_locked: bool,
}

/// `classify` の応答。
#[derive(Debug, Serialize)]
pub struct Classification {
    pub tier: i64,
    pub confidence: f64,
    pub fallback: bool,
    pub gate: Gate,
    pub length: usize,
    pub probabilities: BTreeMap<String, f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_counts_code_points_not_bytes() {
        assert_eq!(visible_length("あいうえお"), 5);
        assert_eq!(visible_length("a😀b"), 3);
    }

    #[test]
    fn length_ignores_whitespace_and_markdown_symbols() {
        assert_eq!(visible_length("### 見出し\n\n* **太字** です\n> 引用"), 9);
    }

    #[test]
    fn length_drops_link_card_lines() {
        let md = "本文です\n<a href=\"https://example.com/a\" class=\"link-card\">https://example.com/a</a>\n";
        assert_eq!(visible_length(md), 4);
    }

    #[test]
    fn length_drops_images_and_keeps_link_labels() {
        let md =
            "![写真](https://example.com/a.jpg)\n[リンク](https://example.com/very/long/path) です";
        assert_eq!(visible_length(md), 5);
    }

    #[test]
    fn length_drops_bare_urls_up_to_the_next_non_ascii_char() {
        assert_eq!(
            visible_length("参考https://example.com/a?b=1#c です https://x.example/"),
            4
        );
    }

    #[test]
    fn length_counts_code_block_contents_but_not_the_fences() {
        let md = "```rust\nlet x = 1;\n```\n";
        assert_eq!(visible_length(md), "letx=1;".chars().count());
    }

    #[test]
    fn length_drops_single_and_multi_line_html_comments() {
        assert_eq!(visible_length("あ<!-- toc -->い"), 2);
        assert_eq!(visible_length("あ\n<!--\n長い\n> 注釈\n-->\nい"), 2);
    }

    #[test]
    fn length_ignores_an_unclosed_comment_to_the_end() {
        assert_eq!(visible_length("あい<!-- 閉じない\nう"), 2);
    }

    #[test]
    fn length_of_empty_markup_is_zero() {
        assert_eq!(visible_length("![](https://example.com/a.png)\n"), 0);
    }

    #[test]
    fn gate_is_long_from_the_gate_length() {
        assert_eq!(Gate::of(LENGTH_GATE - 1), Gate::Short);
        assert_eq!(Gate::of(LENGTH_GATE), Gate::Long);
    }

    #[test]
    fn knowledge_needs_the_threshold() {
        for gate in [Gate::Long, Gate::Short] {
            let at = decide(gate, Pick::Knowledge, 0.65, 0.65);
            assert_eq!(at.tier, Tier::Knowledge);
            assert!(!at.fallback);
            let below = decide(gate, Pick::Knowledge, 0.64, 0.65);
            assert_eq!(below.tier, gate.other_tier());
            assert!(below.fallback);
        }
    }

    #[test]
    fn other_pick_ignores_confidence() {
        for confidence in [0.0, 0.3, 1.0] {
            let long = decide(Gate::Long, Pick::Other, confidence, 0.65);
            assert_eq!((long.tier, long.fallback), (Tier::Long, false));
            let short = decide(Gate::Short, Pick::Other, confidence, 0.65);
            assert_eq!((short.tier, short.fallback), (Tier::Diary, false));
        }
    }

    #[test]
    fn a_gate_never_yields_the_other_side_tier() {
        for pick in [Pick::Knowledge, Pick::Other] {
            for confidence in [0.0, 0.5, 0.65, 1.0] {
                assert_ne!(decide(Gate::Long, pick, confidence, 0.65).tier, Tier::Diary);
                assert_ne!(decide(Gate::Short, pick, confidence, 0.65).tier, Tier::Long);
            }
        }
    }

    #[test]
    fn choices_depend_on_the_gate() {
        assert_eq!(Gate::Long.pick_of("long"), Some(Pick::Other));
        assert_eq!(Gate::Long.pick_of("diary"), None);
        assert_eq!(Gate::Short.pick_of("diary"), Some(Pick::Other));
        assert_eq!(Gate::Short.pick_of("long"), None);
        assert_eq!(Gate::Short.pick_of("knowledge"), Some(Pick::Knowledge));
    }

    #[test]
    fn config_defaults_and_overrides() {
        let default = TierConfig::parse(None, None, None).unwrap();
        assert_eq!(default.model, "@cf/cloudflare/clef-flash");
        assert_eq!(
            default.thresholds,
            Thresholds {
                long: 0.65,
                short: 0.65
            }
        );
        let set =
            TierConfig::parse(Some("@cf/cloudflare/clef"), Some("0.8"), Some(" 0.5 ")).unwrap();
        assert_eq!(set.model, "@cf/cloudflare/clef");
        assert_eq!(set.thresholds.of(Gate::Long), 0.8);
        assert_eq!(set.thresholds.of(Gate::Short), 0.5);
    }

    #[test]
    fn config_rejects_bad_thresholds() {
        for bad in ["abc", "1.5", "-0.1", "NaN"] {
            assert!(TierConfig::parse(None, Some(bad), None).is_err(), "{bad}");
        }
    }

    fn input(json: &str) -> TierInput {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn write_has_three_shapes() {
        assert_eq!(
            parse_tier_write(&input(r#"{"tier":2}"#)),
            Ok(TierWrite::Manual {
                tier: Tier::Knowledge
            })
        );
        assert_eq!(
            parse_tier_write(&input(
                r#"{"tier":3,"tier_confidence":0.91,"source":"auto"}"#
            )),
            Ok(TierWrite::Auto {
                tier: Tier::Diary,
                confidence: 0.91
            })
        );
        assert_eq!(
            parse_tier_write(&input(r#"{"tier_locked":false}"#)),
            Ok(TierWrite::Unlock)
        );
    }

    #[test]
    fn write_rejects_everything_else() {
        for body in [
            r#"{}"#,
            r#"{"tier":4}"#,
            r#"{"tier":0}"#,
            r#"{"tier":2,"tier_confidence":0.9}"#,
            r#"{"tier":2,"source":"auto"}"#,
            r#"{"tier":2,"source":"manual"}"#,
            r#"{"tier":2,"tier_confidence":1.5,"source":"auto"}"#,
            r#"{"tier":2,"tier_locked":false}"#,
            r#"{"tier_locked":true}"#,
            r#"{"tier_locked":false,"tier_confidence":0.5}"#,
        ] {
            assert!(parse_tier_write(&input(body)).is_err(), "{body}");
        }
    }

    #[test]
    fn write_body_rejects_unknown_fields() {
        assert!(serde_json::from_str::<TierInput>(r#"{"tier":2,"content":"x"}"#).is_err());
    }

    #[test]
    fn state_joins_title_categories_and_body() {
        assert_eq!(
            clef_state("題", &["tech".into(), "game".into()], "本文"),
            "題\ntech, game\n\n本文"
        );
    }
}
