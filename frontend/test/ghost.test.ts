import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BAND_BOTTOM_GAP,
  BAND_TOP_GAP,
  BLINK_MAX_MS,
  BLINK_MIN_MS,
  CROSS_ARC_PX,
  CROSS_COOLDOWN_MS,
  CURSOR_NEAR,
  EDGE_GAP,
  MAX_DT,
  NEUTRAL_POSE,
  POSES,
  SPRINGS,
  SWAY_AMP,
  SWAY_CYCLES,
  TILT_MAX,
  TILT_X_MAX,
  X_GAIN_MAX,
  aimFor,
  atRest,
  band,
  bandY,
  blinkDelay,
  clampToBand,
  arcLift,
  crossProgress,
  gaze,
  halfExtent,
  listY,
  mirrorPose,
  pickArticleBlock,
  pickListBlock,
  pickListTarget,
  poseAt,
  readLine,
  resolveSide,
  sectionProgress,
  sideForGroup,
  sideGroups,
  springStep,
  swayX,
  tiltFromHorizontalVelocity,
  tiltFromVelocity,
  xRoom,
  xTarget,
  type SideState,
  type Spring,
  type SpringParams,
} from "../src/lib/ghost.ts";
import { COLUMN_W, GHOST_ASPECT, GHOST_W, NAV_H, ghostX, type Side } from "../src/lib/world.ts";

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

test("読み取り線は文書座標で、スクロールと同じだけ動き、画面の中の上寄りにある", () => {
  for (const vh of [500, 800, 1400]) {
    for (const scrollY of [0, 1000, 25000]) {
      const line = readLine(scrollY, vh);
      assert.ok(line > scrollY && line < scrollY + vh / 2 + 1, `viewport の上半分あたり (${vh}, ${scrollY})`);
      assert.ok(Math.abs(readLine(scrollY + 300, vh) - line - 300) < 1e-9, "スクロールに 1 対 1");
    }
    assert.ok(readLine(0, vh) < readLine(0, vh * 2), "画面が高いほど下がる");
  }
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
    const next = POSES[(i + 1) % n];
    assert.ok(p.scale >= 0.9 && p.scale <= 1.1, `scale ${i}`);
    assert.ok(Math.abs(p.tilt) <= 10, `tilt ${i}`);
    assert.ok(Math.abs(p.x) <= 26, `x ${i}`);
    assert.ok(Math.abs(p.x - next.x) >= 16, `${i} と次の横ずれが近すぎる`);
    assert.ok(p.gaze.x < 0, `gaze.x ${i} は左向き`);
    assert.ok(Math.hypot(p.gaze.x, p.gaze.y) <= 9, `gaze ${i} は目の中に収まる`);
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

const WIDTHS = [985, 1000, 1100, 1199, 1200, 1280, 1600, 1920];
const SIDES: Side[] = ["right", "left"];

test("横のバネは、行き過ぎが小さく、2 秒以内に静止する", () => {
  const { peak, s, settledAt } = run(100, SPRINGS.x, 3);
  assert.ok(peak > 100 && peak < 106, `行き過ぎ ${peak}`);
  assert.ok(atRest(s, 100));
  assert.ok(settledAt < 2, `収束時間 ${settledAt}s`);
});

test("落ち葉: 節の中で 1.5 往復し、振れ幅は SWAY_AMP を超えず、始まりの位相は節ごとに違う", () => {
  for (const block of [0, 1, 5]) {
    let crossings = 0;
    let prev = swayX(0, block);
    for (let i = 1; i <= 1000; i++) {
      const v = swayX(i / 1000, block);
      assert.ok(Math.abs(v) <= SWAY_AMP + 1e-9);
      if (prev * v < 0) crossings++;
      prev = v;
    }
    assert.ok(crossings >= 2 && crossings <= 4, `1.5 往復は半周期 3 つ分で、ゼロ交差は 2 から 4 (${crossings})`);
    assert.ok(Math.abs(swayX(1 / SWAY_CYCLES, block) - swayX(0, block)) < 1e-9, "周期は節の 2/3");
  }
  const starts = POSES.map((_, b) => swayX(0, b));
  for (let b = 0; b < POSES.length; b++) {
    assert.ok(Math.abs(starts[b] - starts[(b + 1) % POSES.length]) > 5, `${b} と次の節で揺れの始まりが近い`);
  }
  assert.equal(swayX(0, 3), swayX(0, 3 + POSES.length), "表の長さで巡る");
  assert.equal(swayX(-1, 2), swayX(0, 2), "範囲外の進み具合は端に張りつく");
});

test("可動範囲: 余白から傾いた見かけの幅と隙間を引いた分で、広い画面ほど大きく、狭ければ 0", () => {
  const flat = { x: 0, tilt: 0, scale: 1, gaze: { x: 0, y: 0 } };
  assert.equal(halfExtent(flat), GHOST_W / 2);
  assert.ok(halfExtent({ ...flat, tilt: 9 }) > halfExtent(flat), "傾くと見かけの幅が広がる");
  assert.equal(xRoom(1000, flat), 60 - 36 - EDGE_GAP);
  assert.equal(xRoom(1280, flat), 130 - 36 - EDGE_GAP);
  assert.equal(xRoom(1600, flat), 210 - 36 - EDGE_GAP);
  assert.ok(xRoom(1000, flat) < xRoom(1280, flat) && xRoom(1280, flat) < xRoom(1600, flat));
  assert.equal(xRoom(800, flat), 0, "余白が見かけの幅より狭いなら 0");
  assert.ok(xRoom(1000, { ...flat, scale: 1.1 }) < xRoom(1000, flat), "大きい姿勢ほど狭い");
});

test("x の目標は、どの幅、側、ブロック、進み具合でも、傾いた見かけの幅が余白の中に隙間つきで収まる", () => {
  for (const width of WIDTHS) {
    const columnLeft = (width - COLUMN_W) / 2;
    const columnRight = (width + COLUMN_W) / 2;
    for (const side of SIDES) {
      for (let block = 0; block < POSES.length * 2; block++) {
        const half = halfExtent(POSES[block % POSES.length]);
        for (let i = 0; i <= 50; i++) {
          const x = xTarget(width, side, block, i / 50);
          const gapToColumn = side === "right" ? x - half - columnRight : columnLeft - (x + half);
          const gapToEdge = side === "right" ? width - (x + half) : x - half;
          const msg = `${width}px ${side} block ${block} progress ${i / 50}`;
          assert.ok(gapToColumn >= EDGE_GAP - 1e-6 || xRoom(width, POSES[block % POSES.length]) === 0, `列との隙間 ${gapToColumn} ${msg}`);
          assert.ok(gapToEdge >= EDGE_GAP - 1e-6 || xRoom(width, POSES[block % POSES.length]) === 0, `端との隙間 ${gapToEdge} ${msg}`);
        }
      }
    }
  }
});

test("x の目標: 幅 1000px ではわずかしか動かず、広いほど動く。一覧には揺れが無い", () => {
  const spread = (width: number) => {
    const xs = Array.from({ length: 101 }, (_, i) => xTarget(width, "right", 1, i / 100));
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(spread(1000) < 12, `1000px で ${spread(1000)}`);
  assert.ok(spread(1280) > 30, `1280px で ${spread(1280)}`);
  assert.ok(spread(1600) >= spread(1280));
  assert.ok(spread(1600) <= 2 * SWAY_AMP * X_GAIN_MAX + 1e-6);
  for (let block = 0; block < POSES.length; block++) {
    const offset = xTarget(1280, "right", block, null) - ghostX(1280);
    assert.equal(Math.sign(offset), Math.sign(POSES[block].x), `block ${block} は姿勢の向きへ寄る`);
    assert.ok(Math.abs(offset) <= Math.abs(POSES[block].x) * X_GAIN_MAX + 1e-9, `block ${block} は揺れを足さない`);
  }
});

test("左の目標は右の鏡で、中立位置は余白の中央どうしの対称", () => {
  for (const width of [1200, 1280, 1600]) {
    for (let block = 0; block < POSES.length; block++) {
      for (const p of [0, 0.3, 0.8]) {
        const r = xTarget(width, "right", block, p);
        const l = xTarget(width, "left", block, p);
        assert.ok(Math.abs(r - ghostX(width, "right") + (l - ghostX(width, "left"))) < 1e-9, "ずれは符号だけ反転");
      }
    }
    assert.equal(ghostX(width, "left"), width - ghostX(width, "right"));
  }
});

test("側は h2 を通った個数の偶奇で決まり、幅 1100px 以下では常に右で、広がる方向にだけ渡る", () => {
  for (const width of [1280, 1600, 1920]) {
    assert.deepEqual([0, 1, 2, 3, 4].map((n) => sideForGroup(n, width)), ["right", "left", "right", "left", "right"]);
  }
  for (const width of [985, 1000, 1100]) {
    assert.deepEqual([0, 1, 2, 3, 4].map((n) => sideForGroup(n, width)), ["right", "right", "right", "right", "right"]);
  }
  let crossesFrom = Infinity;
  for (let width = 985; width <= 2000; width++) {
    const crosses = sideForGroup(1, width) === "left";
    if (crosses && crossesFrom === Infinity) crossesFrom = width;
    assert.equal(crosses, width >= crossesFrom, `${width}px で渡る/渡らないが戻っていない`);
  }
  assert.ok(crossesFrom > 1100 && crossesFrom <= 1280, `渡り始める幅 ${crossesFrom}`);
});

test("h1 と h3 の境目では側が変わらず、h2 を 1 つ通ると変わり、2 つ通ると戻る", () => {
  const side = (heads: string[], at: number) => sideForGroup(sideGroups(heads.map((h) => h === "h2"))[at], 1280);
  const heads = ["h1", "h3", "h3", "h3", "h2", "h3", "h3", "h2", "h3"];
  const sides = heads.map((_, i) => side(heads, i));
  assert.deepEqual(sides, ["right", "right", "right", "right", "left", "left", "left", "right", "right"]);
  assert.deepEqual(sideGroups([]), []);
  assert.deepEqual(sideGroups([false, false, false]), [0, 0, 0], "h2 の無い記事や一覧は常に 0 で渡らない");
});

test("側の切り替えは前回から 600ms 以上たった後だけで、断られても時刻は動かない", () => {
  const first: SideState = { side: "right", switchedAtMs: -Infinity };
  const a = resolveSide(first, "left", 0);
  assert.deepEqual(a, { side: "left", switchedAtMs: 0 }, "最初の切り替えはすぐ通る");
  assert.equal(resolveSide(a, "right", CROSS_COOLDOWN_MS - 1), a, "599ms では戻れない");
  assert.deepEqual(resolveSide(a, "right", CROSS_COOLDOWN_MS), { side: "right", switchedAtMs: CROSS_COOLDOWN_MS });
  assert.equal(resolveSide(a, "left", 5), a, "同じ側なら何もしない");
  assert.equal(resolveSide(a, "left", 100000), a, "同じ側なら時刻も動かない");
});

test("速い切り替えが続いても、側の変更は 600ms あき、静まれば望む側に追いつく", () => {
  let st: SideState = { side: "right", switchedAtMs: -Infinity };
  const switches: number[] = [];
  for (let t = 0; t <= 3000; t += 16) {
    const group = t < 2000 ? Math.floor(t / 100) : 20;
    const next = resolveSide(st, sideForGroup(group, 1280), t);
    if (next.side !== st.side) switches.push(t);
    st = next;
  }
  assert.ok(switches.length >= 3);
  for (let i = 1; i < switches.length; i++) assert.ok(switches[i] - switches[i - 1] >= CROSS_COOLDOWN_MS);
  assert.equal(st.side, "right", "止まれば、h2 の個数の偶奇の側に落ち着く");
});

test("左の姿勢は右の鏡: 視線 x、傾き、横ずれの符号が反転し、大きさと視線 y は同じ", () => {
  for (const p of POSES) {
    assert.equal(mirrorPose(p, "right"), p);
    const m = mirrorPose(p, "left");
    assert.equal(m.tilt, -p.tilt);
    assert.equal(m.gaze.x, -p.gaze.x);
    assert.equal(m.x, -p.x);
    assert.equal(m.gaze.y, p.gaze.y);
    assert.equal(m.scale, p.scale);
    assert.ok(m.gaze.x > 0, "左に立つときは本文の側 (右) を向く");
    assert.deepEqual(mirrorPose(m, "left"), p, "2 回で元に戻る");
  }
});

test("横の速度の傾きは進む向きに傾き、上限で止まる", () => {
  assert.equal(tiltFromHorizontalVelocity(0), 0);
  assert.ok(tiltFromHorizontalVelocity(300) > 0, "右へ動くと右へ傾く");
  assert.equal(tiltFromHorizontalVelocity(-300), -tiltFromHorizontalVelocity(300));
  assert.equal(tiltFromHorizontalVelocity(1e6), TILT_X_MAX);
  assert.equal(tiltFromHorizontalVelocity(-1e6), -TILT_X_MAX);
});

test("渡りの弧は、出発と到着で 0、中ほどで最も高く、上向き", () => {
  assert.equal(crossProgress(100, 900, 100), 0);
  assert.equal(crossProgress(100, 900, 500), 0.5);
  assert.equal(crossProgress(900, 100, 500), 0.5, "左へ渡るときも同じ");
  assert.equal(crossProgress(100, 900, 2000), 1);
  assert.equal(crossProgress(5, 5, 5), 1, "距離 0 で割らない");
  assert.ok(Math.abs(arcLift(0)) < 1e-9);
  assert.ok(Math.abs(arcLift(1)) < 1e-9);
  assert.equal(arcLift(0.5), -CROSS_ARC_PX);
  assert.ok(arcLift(0.25) > arcLift(0.5) && arcLift(0.25) < 0);
});

test("every spring stays stable at the largest time step", () => {
  for (const [name, p] of Object.entries(SPRINGS)) {
    assert.ok(p.omega * MAX_DT < 2, `${name} diverges when omega * MAX_DT >= 2`);
  }
});

test("動きを減らす設定の目標は、ブロックにも進み具合にも側にも依らず、中立の姿勢で右の余白の中央に立つ", () => {
  for (const width of WIDTHS) {
    const rest = aimFor(true, width, "right", 0, null);
    assert.deepEqual(rest.pose, NEUTRAL_POSE);
    assert.equal(rest.pose.tilt, 0);
    assert.equal(rest.pose.scale, 1);
    assert.deepEqual(rest.pose.gaze, { x: 0, y: 0 });
    assert.equal(rest.x, ghostX(width));
    for (const side of SIDES) {
      for (let block = 0; block < POSES.length * 2; block++) {
        for (const progress of [null, 0, 0.37, 1]) {
          assert.deepEqual(aimFor(true, width, side, block, progress), rest, `${width}px ${side} ${block} ${progress}`);
        }
      }
    }
  }
});

test("動きを減らさないときの目標は、ブロックと進み具合で動く", () => {
  const at = (block: number, progress: number | null) => aimFor(false, 1280, "right", block, progress);
  assert.notDeepEqual(at(0, 0).pose, at(1, 0).pose, "ブロックで姿勢が変わる");
  assert.notEqual(at(1, 0).x, at(1, 0.4).x, "進み具合で x が揺れる");
  assert.deepEqual(at(3, 0.2).pose, mirrorPose(poseAt(3), "right"));
  assert.deepEqual(aimFor(false, 1280, "left", 3, 0.2).pose, mirrorPose(poseAt(3), "left"));
});

test("一覧でホバーすると、姿勢と高さはホバーしたカードに寄り、無ければ読み取り線のカード", () => {
  const spans = Array.from({ length: 8 }, (_, i) => ({ top: i * 200, bottom: i * 200 + 200 }));
  const reading: [number, number][] = [[10, 0], [250, 1], [620, 3], [1100, 5], [1599, 7], [9999, 7]];
  for (const [line, card] of reading) {
    assert.equal(pickListTarget(spans, line, null), card, `line ${line}`);
    for (let hovered = 0; hovered < spans.length; hovered++) assert.equal(pickListTarget(spans, line, hovered), hovered);
  }
  assert.equal(pickListTarget(spans, -50, null), 0, "先頭より上でも先頭");
  assert.equal(pickListTarget([], 100, null), 0, "li が無くても 0");
});
