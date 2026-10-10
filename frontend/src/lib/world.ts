export interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

export const STAR_COUNT = 190;

/** official と同じ種と順序で引くので、同じ空になる。座標は 0 から 1 に正規化してあり、画面の大きさで変わらない。 */
export function makeStars(count: number = STAR_COUNT): Star[] {
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const bright = random() < 0.1;
    return {
      x: random(),
      y: random(),
      r: bright ? 0.9 + random() * 0.4 : 0.45 + random() * 0.35,
      a: bright ? 0.6 + random() * 0.3 : 0.22 + random() * 0.28,
    };
  });
}

export const COLUMN_W = 760;
/** これ以上で、本文の列の右の余白にゴーストを置く。余白は (幅 - 760) / 2 で、1000px のとき 120px。 */
export const WIDE_MIN = 1000;
export const GHOST_W = 72;
export const GHOST_ASPECT = 392 / 439;
export const NAV_H = 56;
const TOP_GAP = 16;
const BOTTOM_GAP = 32;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function ghostX(width: number): number {
  const columnRight = (width + COLUMN_W) / 2;
  return (columnRight + width) / 2;
}

export function scrollProgress(scrollY: number, maxScroll: number): number {
  if (maxScroll <= 0) return 0;
  return clamp01(scrollY / maxScroll);
}

export function ghostTop(progress: number, viewportH: number, ghostH: number): number {
  const from = NAV_H + TOP_GAP;
  const to = Math.max(from, viewportH - BOTTOM_GAP - ghostH);
  return from + (to - from) * clamp01(progress);
}

export interface Gaze {
  x: number;
  y: number;
}

export function readingGaze(progress: number, reach: number): Gaze {
  return { x: 0, y: (2 * clamp01(progress) - 1) * reach };
}

export const CURSOR_NEAR = 360;

export function gaze(progress: number, cursor: { dx: number; dy: number } | null, reach: number): Gaze {
  const reading = readingGaze(progress, reach);
  if (!cursor) return reading;
  const len = Math.hypot(cursor.dx, cursor.dy) || 1;
  const w = clamp01(1 - len / CURSOR_NEAR);
  const toward = { x: (cursor.dx / len) * reach, y: (cursor.dy / len) * reach };
  return { x: reading.x + (toward.x - reading.x) * w, y: reading.y + (toward.y - reading.y) * w };
}
