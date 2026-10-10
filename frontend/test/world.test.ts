import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLUMN_W,
  CURSOR_NEAR,
  GHOST_ASPECT,
  GHOST_W,
  NAV_H,
  gaze,
  ghostTop,
  ghostX,
  makeStars,
  readingGaze,
  scrollProgress,
} from "../src/lib/world.ts";

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

test("進み具合は 0 から 1 で、画面に収まるページは 0 のまま", () => {
  assert.equal(scrollProgress(0, 2000), 0);
  assert.equal(scrollProgress(500, 2000), 0.25);
  assert.equal(scrollProgress(2500, 2000), 1);
  assert.equal(scrollProgress(120, 0), 0);
});

test("ゴーストの高さは進み具合に比例して、ナビの下から画面下端の 32px 上まで降りる", () => {
  const vh = 800;
  const h = GHOST_W * GHOST_ASPECT;
  const top = ghostTop(0, vh, h);
  const end = ghostTop(1, vh, h);
  assert.ok(top > NAV_H, "ナビに重ならない");
  assert.equal(end + h, vh - 32);
  assert.equal(ghostTop(0.5, vh, h), (top + end) / 2);
  assert.equal(ghostTop(1.5, vh, h), end);
  assert.ok(ghostTop(0.3, vh, h) < ghostTop(0.31, vh, h), "進むほど下がり、戻せば上がる");
});

test("画面が低くて降りる幅が無いときは上に留まる", () => {
  const h = GHOST_W * GHOST_ASPECT;
  assert.equal(ghostTop(1, 100, h), ghostTop(0, 100, h));
});

test("視線は上端で上、半ばで正面、下端で下を向く", () => {
  assert.deepEqual(readingGaze(0, 8), { x: 0, y: -8 });
  assert.deepEqual(readingGaze(0.5, 8), { x: 0, y: 0 });
  assert.deepEqual(readingGaze(1, 8), { x: 0, y: 8 });
});

test("カーソルが遠いか無いときは本文を読む視線のまま", () => {
  assert.deepEqual(gaze(1, null, 8), readingGaze(1, 8));
  assert.deepEqual(gaze(1, { dx: CURSOR_NEAR, dy: 0 }, 8), readingGaze(1, 8));
  assert.deepEqual(gaze(0, { dx: 2000, dy: -2000 }, 8), readingGaze(0, 8));
});

test("カーソルが近いほど、カーソルの方向を優先する", () => {
  const near = gaze(0, { dx: 40, dy: 0 }, 8);
  const mid = gaze(0, { dx: 240, dy: 0 }, 8);
  assert.ok(near.x > mid.x && mid.x > 0, "近いほど右へ寄る");
  assert.ok(near.x > 6, "すぐそばなら、ほぼカーソルの方向");
  assert.ok(near.y > -2 && mid.y < 0, "近いほど読む視線(上)から離れる");
});
