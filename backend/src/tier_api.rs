use serde::Deserialize;
use serde_json::json;
use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::tier::{self, Classification, Gate, TierConfig, TierInput, TierWrite, WriteOutcome};
use crate::{clef, fetch_post, is_admin, json_error, num};

fn tier_config(env: &Env) -> std::result::Result<TierConfig, String> {
    let var = |name: &str| env.var(name).ok().map(|v| v.to_string());
    TierConfig::parse(
        var("TIER_MODEL").as_deref(),
        var("TIER_THRESHOLD_LONG").as_deref(),
        var("TIER_THRESHOLD_SHORT").as_deref(),
    )
}

pub(crate) async fn classify_post(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let config = match tier_config(&ctx.env) {
        Ok(config) => config,
        Err(message) => {
            console_error!("tier config: {message}");
            return json_error("tier settings are invalid", 500);
        }
    };
    let Ok(ai) = ctx.env.ai("AI") else {
        return json_error("AI binding is not configured", 503);
    };
    let d1 = ctx.env.d1("DB")?;
    let Some(post) = fetch_post(&d1, "id = ?", num(id), true).await? else {
        return json_error("Not Found", 404);
    };

    let length = tier::visible_length(&post.content);
    let gate = Gate::of(length);
    let state = tier::clef_state(&post.title, &post.categories, &post.content);
    let request = clef::build_request(&config.model, gate, &state);
    let raw = match clef::run(&ai, &config.model, &request).await {
        Ok(raw) => raw,
        Err(e) => {
            console_error!("clef call failed: {e}");
            return json_error("classification failed", 502);
        }
    };
    let answer = match clef::read_answer(&raw) {
        Ok(answer) => answer,
        Err(e) => {
            console_error!("clef response unreadable: {e}; response: {raw}");
            return json_error("classification response was not understood", 422);
        }
    };
    let Some(pick) = gate.pick_of(&answer.choice) else {
        console_error!("clef chose {:?}, not offered for {gate:?}", answer.choice);
        return json_error("classification response was not understood", 422);
    };
    let verdict = tier::decide(gate, pick, answer.confidence, config.thresholds.of(gate));
    Response::from_json(&Classification {
        tier: verdict.tier.number(),
        confidence: answer.confidence,
        fallback: verdict.fallback,
        gate,
        length,
        probabilities: answer.probabilities,
    })
}

pub(crate) async fn set_tier(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let input: TierInput = match req.json().await {
        Ok(v) => v,
        Err(_) => return json_error("Invalid JSON body", 400),
    };
    let write = match tier::parse_tier_write(&input) {
        Ok(write) => write,
        Err(message) => return json_error(message, 400),
    };

    let d1 = ctx.env.d1("DB")?;
    let statement = match &write {
        TierWrite::Manual { tier } => d1
            .prepare(
                "UPDATE posts SET tier = ?, tier_confidence = NULL, tier_locked = 1 WHERE id = ?",
            )
            .bind(&[num(tier.number()), num(id)])?,
        TierWrite::Auto { tier, confidence } => d1
            .prepare(
                "UPDATE posts SET tier = ?, tier_confidence = ? WHERE id = ? AND tier_locked = 0",
            )
            .bind(&[num(tier.number()), JsValue::from_f64(*confidence), num(id)])?,
        TierWrite::Unlock => d1
            .prepare("UPDATE posts SET tier_locked = 0 WHERE id = ?")
            .bind(&[num(id)])?,
    };
    let changes = statement
        .run()
        .await?
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes);
    let outcome = tier::write_outcome(&write, changes);
    if outcome == WriteOutcome::Unreadable {
        console_error!("tier write: changes unavailable for post {id}");
        return json_error("tier write result was unreadable", 500);
    }

    let state: Option<TierStateRow> = d1
        .prepare("SELECT tier, tier_confidence, tier_locked FROM posts WHERE id = ?")
        .bind(&[num(id)])?
        .first(None)
        .await?;
    let Some(state) = state else {
        return json_error("Not Found", 404);
    };
    if outcome == WriteOutcome::Locked {
        return json_error("tier is locked", 409);
    }
    Response::from_json(&json!({
        "id": id,
        "tier": state.tier,
        "tier_confidence": state.tier_confidence,
        "tier_locked": state.tier_locked != 0,
    }))
}

#[derive(Deserialize)]
struct TierStateRow {
    tier: Option<i64>,
    tier_confidence: Option<f64>,
    tier_locked: i64,
}
