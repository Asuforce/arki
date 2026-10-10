import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BAND_BOTTOM_GAP,
  BAND_TOP_GAP,
  BLINK_MAX_MS,
  BLINK_MIN_MS,
  CURSOR_NEAR,
  MAX_DT,
  POSES,
  READ_LINE,
  SPRINGS,
  TILT_MAX,
  atRest,
  band,
  bandY,
  blinkDelay,
  clampToBand,
  gaze,
  listY,
  pickArticleBlock,
  pickListBlock,
  poseAt,
  readLine,
  sectionProgress,
  springStep,
  tiltFromVelocity,
  type Spring,
  type SpringParams,
} from "../src/lib/ghost.ts";
import { GHOST_ASPECT, GHOST_W, NAV_H } from "../src/lib/world.ts";

const DT = 1 / 60;

function run(target: number, params: SpringParams, seconds: number, from: Spring = { x: 0, v: 0 }) {
  let s = from;
  let peak = s.x;
  let settledAt = Infinity;
  for (let t = 0; t < seconds; t += DT) {
    s = springStep(s, target, DT, params);
    peak = Math.max(peak, s.x);
    if (atRest(s, target) && settledAt === Infinity) settledAt = t + DT;
    if (!atRest(s, target)) settledAt = Infinity;
  }
  return { s, peak, settledAt };
}

test("位置のバネは目標を少しだけ越えてから、2 秒以内に静止する", () => {
  const { s, peak, settledAt } = run(100, SPRINGS.y, 3);
  assert.ok(peak > 100, "行き過ぎる");
  assert.ok(peak < 108, `行き過ぎは数 % に収まる (${peak})`);
  assert.ok(atRest(s, 100), "静止する");
  assert.ok(settledAt < 2, `収束時間 ${settledAt}s`);
});

test("減衰比が 1 以上なら行き過ぎない", () => {
  const { peak, s } = run(100, { omega: 9, zeta: 1 }, 3);
  assert.ok(peak <= 100.0001);
  assert.ok(atRest(s, 100));
});

test("跳ねのバネは、位置のバネより大きく行き過ぎる", () => {
  const y = run(100, SPRINGS.y, 3).peak;
  const hop = run(100, SPRINGS.hop, 3).peak;
  assert.ok(hop > y);
});

test("dt が上限を超えても、上限の 1 ステップと同じで、発散しない", () => {
  const s = { x: 10, v: 50 };
  assert.deepEqual(springStep(s, 0, 5, SPRINGS.y), springStep(s, 0, MAX_DT, SPRINGS.y));
  assert.deepEqual(springStep(s, 0, -1, SPRINGS.y), { x: 10, v: 50 });
  let t = { x: 1000, v: 0 };
  for (let i = 0; i < 600; i++) t = springStep(t, 0, 10, SPRINGS.hop);
  assert.ok(Math.abs(t.x) < 1, "巨大な dt を与え続けても収束する");
});

test("刻み幅が 8ms でも 32ms でも、同じ時間で近い位置に着く", () => {
  const at = (dt: number) => {
    let s: Spring = { x: 0, v: 0 };
    for (let t = 0; t < 0.5; t += dt) s = springStep(s, 100, dt, SPRINGS.y);
    return s.x;
  };
  assert.ok(Math.abs(at(0.008) - at(0.032)) < 5);
});

test("静止の判定は、位置と速度の両方が小さいときだけ", () => {
  assert.ok(atRest({ x: 100, v: 0 }, 100));
  assert.ok(!atRest({ x: 100, v: 20 }, 100), "通過中は静止ではない");
  assert.ok(!atRest({ x: 99, v: 0 }, 100));
});

test("傾きは進行方向と逆で、速度に比例し、上限で止まる", () => {
  assert.equal(tiltFromVelocity(0), 0);
  assert.ok(tiltFromVelocity(500) < 0, "下へ進むと負");
  assert.ok(tiltFromVelocity(-500) > 0, "上へ進むと正");
  assert.equal(tiltFromVelocity(-500), -tiltFromVelocity(500));
  assert.ok(Math.abs(tiltFromVelocity(400) / tiltFromVelocity(200) - 2) < 1e-9, "上限の手前では比例");
  assert.equal(tiltFromVelocity(1e6), -TILT_MAX);
  assert.equal(tiltFromVelocity(-1e6), TILT_MAX);
});

test("傾きはバネで 0 へ戻る", () => {
  const { s } = run(0, SPRINGS.tilt, 2, { x: -TILT_MAX, v: 0 });
  assert.ok(Math.abs(s.x) < 0.1);
});

test("読み取り線は viewport の高さの 45% で、文書座標になる", () => {
  assert.equal(READ_LINE, 0.45);
  assert.equal(readLine(1000, 800), 1000 + 360);
});

const items = [
  { top: 100, bottom: 200 },
  { top: 200, bottom: 300 },
  { top: 320, bottom: 420 },
];

test("一覧は読み取り線を含む li を選び、境界では次の li に移る", () => {
  assert.equal(pickListBlock(items, 150), 0);
  assert.equal(pickListBlock(items, 199.9), 0);
  assert.equal(pickListBlock(items, 200), 1);
  assert.equal(pickListBlock(items, 419), 2);
});

test("一覧: li の間と外では、直前の li、先頭より上なら先頭、li が無ければ -1", () => {
  assert.equal(pickListBlock(items, 310), 1);
  assert.equal(pickListBlock(items, 10), 0);
  assert.equal(pickListBlock(items, 9999), 2);
  assert.equal(pickListBlock([], 100), -1);
});

test("記事は読み取り線より上にある最後の見出しを選ぶ", () => {
  const tops = [80, 600, 1400, 2200];
  assert.equal(pickArticleBlock(tops, 700), 1);
  assert.equal(pickArticleBlock(tops, 599), 0);
  assert.equal(pickArticleBlock(tops, 600), 1);
  assert.equal(pickArticleBlock(tops, 5000), 3);
  assert.equal(pickArticleBlock(tops, 10), 0, "タイトルより上でも先頭");
  assert.equal(pickArticleBlock([], 10), -1);
});

test("節の中の進み具合は、上端で 0、下端で 1 で、外は端に張りつく", () => {
  const span = { top: 600, bottom: 1400 };
  assert.equal(sectionProgress(span, 600), 0);
  assert.equal(sectionProgress(span, 1000), 0.5);
  assert.equal(sectionProgress(span, 1400), 1);
  assert.equal(sectionProgress(span, 0), 0);
  assert.equal(sectionProgress(span, 9999), 1);
  assert.equal(sectionProgress({ top: 5, bottom: 5 }, 5), 0, "長さ 0 の節で割らない");
});

test("節が変わると、帯の下端から次の節の上端へ戻る", () => {
  const vh = 800;
  const h = GHOST_W * GHOST_ASPECT;
  const bottom = bandY(sectionProgress({ top: 0, bottom: 100 }, 99.9), vh, h);
  const next = bandY(sectionProgress({ top: 100, bottom: 200 }, 100), vh, h);
  assert.ok(bottom > next + 300, "大きく戻る");
});

test("帯は、ナビの下 48px から、ゴーストの下端が画面下端の 96px 上まで", () => {
  const vh = 800;
  const h = GHOST_W * GHOST_ASPECT;
  const { from, to } = band(vh, h);
  assert.equal(from, NAV_H + BAND_TOP_GAP);
  assert.equal(to + h, vh - BAND_BOTTOM_GAP);
  assert.equal(bandY(0, vh, h), from);
  assert.equal(bandY(1, vh, h), to);
  assert.equal(bandY(0.5, vh, h), (from + to) / 2);
  assert.equal(bandY(-3, vh, h), from);
  assert.equal(bandY(3, vh, h), to);
  assert.ok(bandY(0.3, vh, h) < bandY(0.31, vh, h), "進むほど下がる");
});

test("画面が低くて帯が無いときは、上に留まる", () => {
  const h = GHOST_W * GHOST_ASPECT;
  const { from, to } = band(100, h);
  assert.equal(from, to);
  assert.equal(bandY(1, 100, h), from);
});

test("一覧のゴーストは見出し行の高さに中心を合わせ、帯の外には出ない", () => {
  const vh = 800;
  const h = GHOST_W * GHOST_ASPECT;
  assert.equal(listY(400, vh, h), 400 - h / 2);
  assert.equal(listY(-50, vh, h), band(vh, h).from);
  assert.equal(listY(5000, vh, h), band(vh, h).to);
  assert.equal(clampToBand(300, vh, h), 300);
});

test("姿勢の表は、番号を長さで割った余りで引く", () => {
  const n = POSES.length;
  assert.ok(n >= 6);
  assert.equal(poseAt(0), POSES[0]);
  assert.equal(poseAt(n), POSES[0]);
  assert.equal(poseAt(n + 3), POSES[3]);
  assert.equal(poseAt(-1), POSES[n - 1]);
  for (const i of [0, 1, 17, 1000, 123456]) assert.ok(POSES.includes(poseAt(i)));
});

test("姿勢の値は範囲内で、本文のある左を向き、隣り合う姿勢は似ていない", () => {
  const n = POSES.length;
  for (let i = 0; i < n; i++) {
    const p = POSES[i];
    assert.ok(p.scale >= 0.9 && p.scale <= 1.1, `scale ${i}`);
    assert.ok(Math.abs(p.tilt) <= 10, `tilt ${i}`);
    assert.ok(p.gaze.x < 0, `gaze.x ${i} は左向き`);
    assert.ok(Math.hypot(p.gaze.x, p.gaze.y) <= 9, `gaze ${i} は目の中に収まる`);
    const next = POSES[(i + 1) % n];
    assert.ok(Math.abs(p.tilt - next.tilt) >= 6, `${i} と次の傾きが近すぎる`);
    const differs =
      Math.abs(p.scale - next.scale) >= 0.04 || Math.hypot(p.gaze.x - next.gaze.x, p.gaze.y - next.gaze.y) >= 2;
    assert.ok(differs, `${i} と次の大きさも視線も近すぎる`);
  }
});

test("カーソルが遠いか無いときは、姿勢の基準の視線のまま", () => {
  const base = { x: -6, y: 2 };
  assert.deepEqual(gaze(base, null, 8), base);
  assert.deepEqual(gaze(base, { dx: CURSOR_NEAR, dy: 0 }, 8), base);
  assert.deepEqual(gaze(base, { dx: 2000, dy: -2000 }, 8), base);
});

test("カーソルが近いほど、基準よりカーソルの方向を優先する", () => {
  const base = { x: -6, y: 0 };
  const near = gaze(base, { dx: 40, dy: 0 }, 8);
  const mid = gaze(base, { dx: 240, dy: 0 }, 8);
  assert.ok(near.x > mid.x && mid.x > base.x, "近いほど右へ寄る");
  assert.ok(near.x > 5, "すぐそばなら、ほぼカーソルの方向");
});

test("まばたきの間隔は 3 秒から 7 秒で、何度引いても同じ列になる", () => {
  const seq = Array.from({ length: 200 }, (_, n) => blinkDelay(n));
  assert.deepEqual(seq, Array.from({ length: 200 }, (_, n) => blinkDelay(n)));
  for (const d of seq) assert.ok(d >= BLINK_MIN_MS && d < BLINK_MAX_MS, `${d}`);
  assert.ok(new Set(seq.map((d) => Math.round(d))).size > 150, "ばらつく");
  const mean = seq.reduce((a, b) => a + b, 0) / seq.length;
  assert.ok(Math.abs(mean - 5000) < 400, `平均 ${mean} は範囲の中ほど`);
  assert.ok(Math.min(...seq) < 3600 && Math.max(...seq) > 6400, "範囲の端まで使う");
});
