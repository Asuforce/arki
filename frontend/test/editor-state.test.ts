import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPayload, sameSnapshot, type Snapshot } from "../src/lib/editor-state.ts";

const saved: Snapshot = { title: "題", content: "本文", categories: ["a"], date: "2026-10-01T12:00" };
const fields = { status: "draft" as const, updatedAt: "2026-10-12T00:00:00Z" };

test("日付と slug を変えていなければ送らない（読んだ値の送り返しで固定させない）", () => {
  const payload = buildPayload({ ...saved, content: "直した" }, saved, {
    ...fields,
    slug: { enabled: true, value: "2026/10/01/120000", current: "2026/10/01/120000" },
  });
  assert.equal("published_at" in payload, false);
  assert.equal("slug" in payload, false);
  assert.equal((payload as { expected_updated_at: string }).expected_updated_at, fields.updatedAt);
});

test("日付を変えたら JST を UTC にして送る", () => {
  const payload = buildPayload({ ...saved, date: "2026-10-01T15:30" }, saved, fields) as { published_at: string };
  assert.equal(payload.published_at, "2026-10-01T06:30:00Z");
});

test("決まった日付は空にするとエラーにする", () => {
  assert.deepEqual(buildPayload({ ...saved, date: "" }, saved, fields), { error: "公開日時は空にできません" });
});

test("もともと空の日付は、空のままで保存できる", () => {
  const unset = { ...saved, date: "" };
  assert.equal("published_at" in buildPayload(unset, unset, fields), false);
});

test("slug は変更を許可して、値が違うときだけ送る", () => {
  const edited = { enabled: true, value: "my/post", current: "2026/10/01/120000" };
  assert.equal((buildPayload(saved, saved, { ...fields, slug: edited }) as { slug: string }).slug, "my/post");
  assert.equal("slug" in buildPayload(saved, saved, { ...fields, slug: { ...edited, enabled: false } }), false);
});

test("新規作成は expected_updated_at を付けない", () => {
  assert.equal("expected_updated_at" in buildPayload(saved, saved, { status: "draft", updatedAt: null }), false);
});

test("スナップショットの比較は順序も見る", () => {
  assert.equal(sameSnapshot(saved, { ...saved }), true);
  assert.equal(sameSnapshot(saved, { ...saved, categories: ["b"] }), false);
});
