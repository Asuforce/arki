//! 応答のうち `answers.<key>.choice` だけが公式のドキュメントにある。
//! `confidence` と `probabilities` の場所は未確認なので、読む場所は `read_answer` の 1 か所にする。

use crate::tier::Gate;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use worker::Ai;

pub const QUESTION_KEY: &str = "tier";
const MODEL_PREFIX: &str = "@cf/cloudflare/";

#[derive(Debug, Serialize)]
pub struct ClefRequest<'a> {
    model: &'a str,
    state: &'a str,
    questions: Questions<'a>,
}

#[derive(Debug, Serialize)]
struct Questions<'a> {
    tier: Question<'a>,
}

#[derive(Debug, Serialize)]
struct Question<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    instructions: &'static str,
    criteria: Criteria<'a>,
}

#[derive(Debug, Serialize)]
struct Criteria<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    long: Option<&'a str>,
    knowledge: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    diary: Option<&'a str>,
}

pub fn build_request<'a>(model_id: &'a str, gate: Gate, state: &'a str) -> ClefRequest<'a> {
    let other = gate.other_description();
    ClefRequest {
        model: model_id.strip_prefix(MODEL_PREFIX).unwrap_or(model_id),
        state,
        questions: Questions {
            tier: Question {
                kind: "choice",
                instructions: gate.instructions(),
                criteria: Criteria {
                    long: (gate == Gate::Long).then_some(other),
                    knowledge: gate.knowledge_description(),
                    diary: (gate == Gate::Short).then_some(other),
                },
            },
        },
    }
}

#[derive(Debug, PartialEq)]
pub struct ClefAnswer {
    pub choice: String,
    pub confidence: f64,
    pub probabilities: BTreeMap<String, f64>,
}

#[derive(Debug, PartialEq)]
pub struct ReadError(pub String);

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn read_answer(response: &Value) -> Result<ClefAnswer, ReadError> {
    let answer = response
        .pointer(&format!("/answers/{QUESTION_KEY}"))
        .ok_or_else(|| ReadError(format!("response has no answers.{QUESTION_KEY}")))?;
    let choice = answer
        .get("choice")
        .and_then(Value::as_str)
        .ok_or_else(|| ReadError("answer has no choice".into()))?
        .to_string();
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|c| (0.0..=1.0).contains(c))
        .ok_or_else(|| ReadError("answer has no confidence between 0 and 1".into()))?;
    let probabilities = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_f64().map(|p| (k.clone(), p)))
                .collect()
        })
        .unwrap_or_default();
    Ok(ClefAnswer {
        choice,
        confidence,
        probabilities,
    })
}

pub async fn run(ai: &Ai, model_id: &str, request: &ClefRequest<'_>) -> worker::Result<Value> {
    ai.run(model_id, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_for_the_long_gate_offers_long_and_knowledge() {
        let value = serde_json::to_value(build_request(
            "@cf/cloudflare/clef-flash",
            Gate::Long,
            "題\n\n本文",
        ))
        .unwrap();
        assert_eq!(value["model"], "clef-flash");
        assert_eq!(value["state"], "題\n\n本文");
        let question = &value["questions"]["tier"];
        assert_eq!(question["type"], "choice");
        let keys: Vec<&String> = question["criteria"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["knowledge", "long"]);
    }

    #[test]
    fn request_for_the_short_gate_offers_knowledge_and_diary() {
        let value = serde_json::to_value(build_request("clef", Gate::Short, "s")).unwrap();
        assert_eq!(value["model"], "clef");
        let keys: Vec<&String> = value["questions"]["tier"]["criteria"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        assert_eq!(keys, ["diary", "knowledge"]);
    }

    #[test]
    fn request_keys_are_the_ones_the_gate_accepts_back() {
        for gate in [Gate::Long, Gate::Short] {
            let value = serde_json::to_value(build_request("clef", gate, "s")).unwrap();
            for key in value["questions"]["tier"]["criteria"]
                .as_object()
                .unwrap()
                .keys()
            {
                assert!(gate.pick_of(key).is_some(), "{key}");
            }
        }
    }

    #[test]
    fn reads_choice_confidence_and_probabilities() {
        let response = json!({"answers": {"tier": {
            "choice": "knowledge",
            "confidence": 0.58,
            "probabilities": {"knowledge": 0.54, "diary": 0.46},
        }}});
        let answer = read_answer(&response).unwrap();
        assert_eq!(answer.choice, "knowledge");
        assert_eq!(answer.confidence, 0.58);
        assert_eq!(answer.probabilities["diary"], 0.46);
    }

    #[test]
    fn missing_probabilities_are_empty_not_an_error() {
        let response = json!({"answers": {"tier": {"choice": "diary", "confidence": 0.9}}});
        assert!(read_answer(&response).unwrap().probabilities.is_empty());
    }

    #[test]
    fn missing_or_out_of_range_fields_are_errors() {
        for response in [
            json!({}),
            json!({"answers": {}}),
            json!({"answers": {"tier": {"confidence": 0.5}}}),
            json!({"answers": {"tier": {"choice": "diary"}}}),
            json!({"answers": {"tier": {"choice": "diary", "confidence": 1.2}}}),
            json!({"answers": {"tier": {"choice": "diary", "confidence": "0.5"}}}),
        ] {
            assert!(read_answer(&response).is_err(), "{response}");
        }
    }
}
