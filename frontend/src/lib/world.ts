export interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

export const STAR_COUNT = 190;

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

export const COLUMN_W = 880;
export const WIDE_MIN = 1100;
export const GHOST_W = 72;
export const GHOST_ASPECT = 392 / 439;
export const NAV_H = 56;

export type Side = "right" | "left";

export function ghostX(width: number, side: Side = "right"): number {
  const columnRight = (width + COLUMN_W) / 2;
  const right = (columnRight + width) / 2;
  return side === "right" ? right : width - right;
}

export function marginWidth(width: number): number {
  return Math.max(0, (width - COLUMN_W) / 2);
}
