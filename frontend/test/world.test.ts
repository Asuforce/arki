import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMN_W, GHOST_W, ghostX, makeStars } from "../src/lib/world.ts";

test("星は official と同じ固定の空で、何度作っても変わらない", () => {
  const stars = makeStars();
  assert.equal(stars.length, 190);
  assert.deepEqual(stars, makeStars());
  assert.equal(stars[0].x, 0.10590326134115458);
  assert.equal(stars[0].y, 0.675290479324758);
  assert.equal(stars[189].a, 0.2406758615653962);
  for (const s of stars) {
    assert.ok(s.x >= 0 && s.x < 1 && s.y >= 0 && s.y < 1);
    assert.ok(s.r >= 0.45 && s.r <= 1.3);
    assert.ok(s.a >= 0.22 && s.a <= 0.9);
  }
});

test("ゴーストは本文の列の右の余白の中央にいて、本文にも画面の端にも重ならない", () => {
  for (const w of [1000, 1280, 1920]) {
    const columnRight = (w + COLUMN_W) / 2;
    const x = ghostX(w);
    assert.equal(x - columnRight, w - x);
    assert.ok(x - GHOST_W / 2 > columnRight, `${w}px で本文に重ならない`);
    assert.ok(x + GHOST_W / 2 < w, `${w}px で画面に収まる`);
  }
});
