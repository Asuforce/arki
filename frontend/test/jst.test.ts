import assert from "node:assert/strict";
import { test } from "node:test";
import { fromJstInput, toJstInput } from "../src/lib/jst.ts";

test("UTC を JST の入力値にする", () => {
  assert.equal(toJstInput("2019-11-22T18:13:44Z"), "2019-11-23T03:13");
  assert.equal(toJstInput("2026-12-31T15:00:00Z"), "2027-01-01T00:00");
});

test("JST の入力値を UTC の ISO にする", () => {
  assert.equal(fromJstInput("2019-11-23T03:13"), "2019-11-22T18:13:00Z");
  assert.equal(fromJstInput("2027-01-01T00:00"), "2026-12-31T15:00:00Z");
});

test("読めない値は null", () => {
  assert.equal(fromJstInput(""), null);
  assert.equal(fromJstInput("2019-13-40T99:99"), null);
  assert.equal(fromJstInput("2019-11-23"), null);
});
