import { GHOST_ASPECT, GHOST_W, NAV_H, ghostX, marginWidth, type Side } from "./world";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface Gaze {
  x: number;
  y: number;
}

export interface Pose {
  x: number;
  tilt: number;
  scale: number;
  gaze: Gaze;
}

export const POSES: readonly Pose[] = [
  { x: 14, tilt: -4, scale: 1.0, gaze: { x: -6, y: 1 } },
  { x: -18, tilt: 7, scale: 0.94, gaze: { x: -8, y: -3 } },
  { x: 22, tilt: -9, scale: 1.06, gaze: { x: -4, y: 4 } },
  { x: -8, tilt: 3, scale: 0.92, gaze: { x: -7, y: 0 } },
  { x: 26, tilt: -6, scale: 1.1, gaze: { x: -8, y: 3 } },
  { x: -22, tilt: 9, scale: 0.98, gaze: { x: -3, y: -4 } },
  { x: 6, tilt: -2, scale: 0.9, gaze: { x: -6, y: 5 } },
  { x: -14, tilt: 5, scale: 1.04, gaze: { x: -8, y: -1 } },
];

export function poseIndex(block: number): number {
  const n = POSES.length;
  return ((Math.trunc(block) % n) + n) % n;
}

export function poseAt(block: number): Pose {
  return POSES[poseIndex(block)];
}

const sideSign = (side: Side): number => (side === "right" ? 1 : -1);

export function mirrorPose(pose: Pose, side: Side): Pose {
  if (side === "right") return pose;
  return { x: -pose.x, tilt: -pose.tilt, scale: pose.scale, gaze: { x: -pose.gaze.x, y: pose.gaze.y } };
}

export interface Spring {
  x: number;
  v: number;
}

export interface SpringParams {
  omega: number;
  zeta: number;
}

export const SPRINGS = {
  x: { omega: 8, zeta: 0.7 },
  y: { omega: 9, zeta: 0.7 },
  tilt: { omega: 14, zeta: 0.55 },
  scale: { omega: 10, zeta: 0.75 },
  hop: { omega: 18, zeta: 0.4 },
} as const satisfies Record<string, SpringParams>;

export const MAX_DT = 0.032;

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

export const TILT_PER_SPEED = 0.005;
export const TILT_MAX = 8;

export function tiltFromVelocity(speed: number): number {
  return -clamp(speed * TILT_PER_SPEED, -TILT_MAX, TILT_MAX) || 0;
}

export const TILT_PER_VX = 0.03;
export const TILT_X_MAX = 12;

export function tiltFromHorizontalVelocity(vx: number): number {
  return clamp(vx * TILT_PER_VX, -TILT_X_MAX, TILT_X_MAX) || 0;
}

export interface Span {
  top: number;
  bottom: number;
}

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

export function pickListTarget(items: readonly Span[], line: number, hovered: number | null): number {
  return hovered ?? Math.max(0, pickListBlock(items, line));
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

export const EDGE_GAP = 12;

export function halfExtent(pose: Pose): number {
  const t = (Math.abs(pose.tilt) * Math.PI) / 180;
  return (pose.scale * (GHOST_W * Math.cos(t) + GHOST_W * GHOST_ASPECT * Math.sin(t))) / 2;
}

export function xRoom(width: number, pose: Pose): number {
  return Math.max(0, marginWidth(width) / 2 - halfExtent(pose) - EDGE_GAP);
}

export const SWAY_AMP = 28;
export const SWAY_CYCLES = 1.5;
export const GOLDEN_ANGLE_RAD = 2.4;

export function swayX(progress: number, block: number): number {
  return SWAY_AMP * Math.sin(2 * Math.PI * SWAY_CYCLES * clamp(progress, 0, 1) + poseIndex(block) * GOLDEN_ANGLE_RAD);
}

export const X_GAIN_MAX = 1.5;
const X_RAW_MAX = Math.max(...POSES.map((p) => Math.abs(p.x))) + SWAY_AMP;

export function xTarget(width: number, side: Side, block: number, progress: number | null): number {
  const pose = poseAt(block);
  const raw = pose.x + (progress === null ? 0 : swayX(progress, block));
  const gain = Math.min(X_GAIN_MAX, xRoom(width, pose) / X_RAW_MAX);
  return ghostX(width, side) + sideSign(side) * raw * gain;
}

export const NEUTRAL_POSE: Pose = { x: 0, tilt: 0, scale: 1, gaze: { x: 0, y: 0 } };

export interface Aim {
  x: number;
  pose: Pose;
}

export function aimFor(reduced: boolean, width: number, side: Side, block: number, progress: number | null): Aim {
  if (reduced) return { x: ghostX(width), pose: NEUTRAL_POSE };
  return { x: xTarget(width, side, block, progress), pose: mirrorPose(poseAt(block), side) };
}

export const CROSS_SIDES_MIN_WIDTH = 1200;
export const CROSS_COOLDOWN_MS = 600;

export function sideGroups(isH2: readonly boolean[]): number[] {
  let seen = 0;
  return isH2.map((h2) => (h2 ? ++seen : seen));
}

export function sideForGroup(group: number, width: number): Side {
  if (width < CROSS_SIDES_MIN_WIDTH) return "right";
  return Math.trunc(group) % 2 === 0 ? "right" : "left";
}

export interface SideState {
  side: Side;
  switchedAtMs: number;
}

export function resolveSide(prev: SideState, desired: Side, now: number): SideState {
  if (desired === prev.side || now - prev.switchedAtMs < CROSS_COOLDOWN_MS) return prev;
  return { side: desired, switchedAtMs: now };
}

export function crossProgress(from: number, to: number, x: number): number {
  if (from === to) return 1;
  return clamp((x - from) / (to - from), 0, 1);
}

export const CROSS_ARC_PX = 56;
export function arcLift(progress: number): number {
  return -CROSS_ARC_PX * Math.sin(Math.PI * clamp(progress, 0, 1));
}

export const CROSS_DONE_PX = 40;
