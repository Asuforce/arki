import { NAV_H } from "./world";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface Gaze {
  x: number;
  y: number;
}

/** tilt は度、gaze は瞳の基準の寄り (SVG の単位)。 */
export interface Pose {
  tilt: number;
  scale: number;
  gaze: Gaze;
}

/**
 * 本文は列の左にあるので、基本は左向き。隣り合う姿勢 (末尾と先頭も) は傾きが 6 度以上離れる。
 * scale は 0.9 から 1.1 に収める。
 */
export const POSES: readonly Pose[] = [
  { tilt: -4, scale: 1.0, gaze: { x: -6, y: 1 } },
  { tilt: 7, scale: 0.94, gaze: { x: -8, y: -3 } },
  { tilt: -9, scale: 1.06, gaze: { x: -4, y: 4 } },
  { tilt: 3, scale: 0.92, gaze: { x: -7, y: 0 } },
  { tilt: -6, scale: 1.1, gaze: { x: -8, y: 3 } },
  { tilt: 9, scale: 0.98, gaze: { x: -3, y: -4 } },
  { tilt: -2, scale: 0.9, gaze: { x: -6, y: 5 } },
  { tilt: 5, scale: 1.04, gaze: { x: -8, y: -1 } },
];

export function poseAt(block: number): Pose {
  const n = POSES.length;
  return POSES[((Math.trunc(block) % n) + n) % n];
}

export interface Spring {
  x: number;
  v: number;
}

export interface SpringParams {
  /** 固有角振動数 (rad/s) */
  omega: number;
  /** 減衰比 */
  zeta: number;
}

/**
 * 減衰比 0.7 で行き過ぎは約 5%、固有角振動数 9 で 1 秒ほどで落ち着く。
 * 傾きと跳ねは行き過ぎを大きくして、布の揺り戻しと弾みを出す。
 */
export const SPRINGS = {
  y: { omega: 9, zeta: 0.7 },
  tilt: { omega: 14, zeta: 0.55 },
  scale: { omega: 10, zeta: 0.75 },
  hop: { omega: 18, zeta: 0.4 },
} as const satisfies Record<string, SpringParams>;

/** タブを開き直した直後などの長い 1 コマで、積分が発散して飛ばないための上限 (秒)。 */
export const MAX_DT = 0.032;

/** 半陰的オイラー。ω・dt が 2 未満なら発散しないので、MAX_DT なら ω は 60 まで使える。 */
export function springStep(s: Spring, target: number, dt: number, p: SpringParams): Spring {
  const h = clamp(dt, 0, MAX_DT);
  const v = s.v + (p.omega * p.omega * (target - s.x) - 2 * p.zeta * p.omega * s.v) * h;
  return { x: s.x + v * h, v };
}

export const REST_POS = 0.05;
export const REST_VEL = 0.5;

export function atRest(s: Spring, target: number): boolean {
  return Math.abs(target - s.x) < REST_POS && Math.abs(s.v) < REST_VEL;
}

/** 1000px/s のスクロールで 5 度。上限 8 度は、姿勢の傾き (最大 9 度) と足しても 17 度までで、余白に収まる範囲。 */
export const TILT_PER_SPEED = 0.005;
export const TILT_MAX = 8;

export function tiltFromVelocity(speed: number): number {
  return -clamp(speed * TILT_PER_SPEED, -TILT_MAX, TILT_MAX) || 0;
}

export interface Span {
  top: number;
  bottom: number;
}

/** 目が置かれやすい、画面の中央より少し上。 */
export const READ_LINE = 0.45;

export function readLine(scrollY: number, viewportH: number): number {
  return scrollY + viewportH * READ_LINE;
}

export function pickListBlock(items: readonly Span[], line: number): number {
  if (items.length === 0) return -1;
  let found = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].top <= line) found = i;
  }
  return found;
}

export function pickArticleBlock(tops: readonly number[], line: number): number {
  return pickListBlock(
    tops.map((top) => ({ top, bottom: top })),
    line,
  );
}

export function sectionProgress(span: Span, line: number): number {
  const len = span.bottom - span.top;
  if (len <= 0) return 0;
  return clamp((line - span.top) / len, 0, 1);
}

export const BAND_TOP_GAP = 48;
export const BAND_BOTTOM_GAP = 96;

export function band(viewportH: number, ghostH: number): { from: number; to: number } {
  const from = NAV_H + BAND_TOP_GAP;
  return { from, to: Math.max(from, viewportH - BAND_BOTTOM_GAP - ghostH) };
}

export function clampToBand(y: number, viewportH: number, ghostH: number): number {
  const { from, to } = band(viewportH, ghostH);
  return clamp(y, from, to);
}

export function bandY(progress: number, viewportH: number, ghostH: number): number {
  const { from, to } = band(viewportH, ghostH);
  return from + (to - from) * clamp(progress, 0, 1);
}

export function listY(titleMid: number, viewportH: number, ghostH: number): number {
  return clampToBand(titleMid - ghostH / 2, viewportH, ghostH);
}

export const CURSOR_NEAR = 360;

export function gaze(base: Gaze, cursor: { dx: number; dy: number } | null, reach: number): Gaze {
  if (!cursor) return base;
  const len = Math.hypot(cursor.dx, cursor.dy) || 1;
  const w = clamp(1 - len / CURSOR_NEAR, 0, 1);
  const toward = { x: (cursor.dx / len) * reach, y: (cursor.dy / len) * reach };
  return { x: base.x + (toward.x - base.x) * w, y: base.y + (toward.y - base.y) * w };
}

export const BLINK_MIN_MS = 3000;
export const BLINK_MAX_MS = 7000;
export const BLINK_MS = 120;

/** 種を n から作るので、順番に引いても飛ばして引いても同じ列になる。 */
export function blinkDelay(n: number): number {
  let t = (Math.imul(n + 1, 0x9e3779b9) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return BLINK_MIN_MS + r * (BLINK_MAX_MS - BLINK_MIN_MS);
}

export const HOP_SINK_PX = 4;
export const HOP_SINK_MS = 90;
export const HOP_KICK = -320;

export const FLOAT_IDLE = 1;
export const FLOAT_MOVING = 0.15;
