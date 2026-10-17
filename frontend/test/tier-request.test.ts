import assert from "node:assert/strict";
import { test } from "node:test";
import { tierPatchBody } from "../src/lib/tier-request.ts";

test("人が決める tier とロック解除は、API に渡す本文に変わる", () => {
  assert.equal(tierPatchBody({ tier: 2 }), '{"tier":2}');
  assert.equal(tierPatchBody({ tier_locked: false }), '{"tier_locked":false}');
});

test("バッチ用の書き方は通さない", () => {
  assert.equal(tierPatchBody({ tier: 2, tier_confidence: 0.9, source: "auto" }), null);
  assert.equal(tierPatchBody({ tier: 2, source: "auto" }), null);
  assert.equal(tierPatchBody({ tier: 2, tier_confidence: 0.9 }), null);
});

test("不正な本文は通さない", () => {
  for (const bad of [null, undefined, "tier", 2, [], [{ tier: 2 }], {}, { tier: 0 }, { tier: 4 }, { tier: "2" }, { tier: null }, { tier: 2.5 }, { tier_locked: true }, { tier_locked: "false" }, { tier: 1, tier_locked: false }]) {
    assert.equal(tierPatchBody(bad), null, JSON.stringify(bad));
  }
});
