import {
  BLINK_MS,
  CROSS_DONE_PX,
  FLOAT_IDLE,
  FLOAT_MOVING,
  HOP_KICK,
  HOP_SINK_MS,
  HOP_SINK_PX,
  MAX_DT,
  NEUTRAL_POSE,
  SPRINGS,
  aimFor,
  arcLift,
  atRest,
  bandY,
  blinkDelay,
  crossProgress,
  gaze,
  listY,
  pickArticleBlock,
  pickListTarget,
  readLine,
  resolveSide,
  sectionProgress,
  sideForBlock,
  springStep,
  tiltFromHorizontalVelocity,
  tiltFromVelocity,
  type Pose,
  type SideState,
  type Span,
  type Spring,
} from "../lib/ghost";
import { GHOST_W, WIDE_MIN } from "../lib/world";

const PUPIL_REACH = 8;
const SCROLL_SMOOTH_PER_S = 10;
const SCROLL_REST = 5;

type Layout =
  | { kind: "list"; spans: Span[]; titleMids: number[] }
  | { kind: "article"; tops: number[]; spans: Span[] }
  | { kind: "none" };

interface Target {
  block: number;
  readBlock: number;
  y: number;
  progress: number | null;
}

const docTop = (el: Element): number => el.getBoundingClientRect().top + window.scrollY;

function measure(): Layout {
  const items = [...document.querySelectorAll<HTMLElement>(".post-list > li")];
  if (items.length > 0) {
    const spans = items.map((li) => ({ top: docTop(li), bottom: docTop(li) + li.offsetHeight }));
    const titleMids = items.map((li) => {
      const title = li.querySelector(".post-title") ?? li;
      return docTop(title) + title.getBoundingClientRect().height / 2;
    });
    return { kind: "list", spans, titleMids };
  }
  const post = document.querySelector<HTMLElement>(".post");
  const title = post?.querySelector("h1");
  if (post && title) {
    const heads = [title, ...post.querySelectorAll(".post-body h2, .post-body h3")];
    const tops = heads.map(docTop);
    const end = docTop(post) + post.offsetHeight;
    const spans = tops.map((top, i) => ({ top, bottom: tops[i + 1] ?? end }));
    return { kind: "article", tops, spans };
  }
  return { kind: "none" };
}

function initBlink(pupils: SVGElement[], reduced: MediaQueryList): () => void {
  let n = 0;
  const blink = (): void => {
    if (reduced.matches || document.hidden) return;
    for (const p of pupils) {
      p.animate([{ scale: "1 1" }, { scale: "1 0.08" }, { scale: "1 1" }], {
        duration: BLINK_MS,
        easing: "ease-in-out",
      });
    }
  };
  const next = (): void => {
    window.setTimeout(() => {
      blink();
      next();
    }, blinkDelay(n++));
  };
  next();
  return blink;
}

export function initGhost(): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const pupils = [...document.querySelectorAll<SVGElement>(".ghost-pupil")];
  const blinkNow = initBlink(pupils, reduced);

  const ghost = document.querySelector<HTMLElement>(".ghost-float");
  if (!ghost) return;

  const wide = window.matchMedia(`(min-width: ${WIDE_MIN}px)`);
  const finePointer = window.matchMedia("(pointer: fine)");
  let layout: Layout = { kind: "none" };
  let pointer: { x: number; y: number } | null = null;
  let hovered: number | null = null;

  const y: Spring = { x: 0, v: 0 };
  const tilt: Spring = { x: 0, v: 0 };
  const scale: Spring = { x: 1, v: 0 };
  const hop: Spring = { x: 0, v: 0 };
  const xs: Spring = { x: 0, v: 0 };
  let sideState: SideState = { side: "right", switchedAtMs: -Infinity };
  let crossing = false;
  let crossFrom = 0;
  let lastWidth = 0;
  let block = -1;
  let pose: Pose = NEUTRAL_POSE;
  let running = false;
  let lastTime = 0;
  let lastScroll = window.scrollY;
  let scrollVel = 0;
  let hopStart = -1;
  let hopKicked = true;

  const width = (): number => document.documentElement.clientWidth;

  const target = (ghostH: number): Target => {
    const vh = window.innerHeight;
    if (reduced.matches) return { block: 0, readBlock: 0, y: bandY(0, vh, ghostH), progress: null };
    const line = readLine(window.scrollY, vh);
    const scrollable = document.documentElement.scrollHeight > vh;
    if (layout.kind === "list") {
      const { block: i, readBlock } = pickListTarget(layout.spans, line, hovered);
      return { block: i, readBlock, y: listY(layout.titleMids[i] - window.scrollY, vh, ghostH), progress: null };
    }
    if (layout.kind === "article") {
      const i = Math.max(0, pickArticleBlock(layout.tops, line));
      const progress = scrollable ? sectionProgress(layout.spans[i], line) : 0;
      return { block: i, readBlock: i, y: bandY(progress, vh, ghostH), progress };
    }
    return { block: 0, readBlock: 0, y: bandY(0, vh, ghostH), progress: null };
  };

  const render = (): void => {
    const h = ghost.offsetHeight;
    ghost.style.transform =
      `translate(${xs.x - GHOST_W / 2}px, ${y.x + hop.x}px) rotate(${tilt.x}deg) scale(${scale.x})`;
    ghost.dataset.side = sideState.side;
    ghost.toggleAttribute("data-crossing", crossing);

    const cursor =
      pointer && finePointer.matches && !reduced.matches
        ? { dx: pointer.x - xs.x, dy: pointer.y - (y.x + h / 2) }
        : null;
    const eyes = gaze(pose.gaze, cursor, PUPIL_REACH);
    ghost.style.setProperty("--gx", eyes.x.toFixed(2));
    ghost.style.setProperty("--gy", eyes.y.toFixed(2));
  };

  const react = (now: number): void => {
    hopStart = now;
    hopKicked = false;
    blinkNow();
  };

  const settle = (): void => {
    const t = target(ghost.offsetHeight);
    const w = width();
    lastWidth = w;
    block = t.block;
    sideState = { side: sideForBlock(t.readBlock, w), switchedAtMs: sideState.switchedAtMs };
    crossing = false;
    const aim = aimFor(reduced.matches, w, sideState.side, t.block, t.progress);
    pose = aim.pose;
    xs.x = aim.x;
    xs.v = 0;
    y.x = t.y;
    tilt.x = pose.tilt;
    scale.x = pose.scale;
    y.v = tilt.v = scale.v = hop.v = 0;
    hop.x = 0;
  };

  const frame = (now: number): void => {
    const real = lastTime ? (now - lastTime) / 1000 : 1 / 60;
    lastTime = now;
    const dt = Math.min(real, MAX_DT);

    const scrollY = window.scrollY;
    const raw = real > 0 ? (scrollY - lastScroll) / real : 0;
    lastScroll = scrollY;
    scrollVel += (raw - scrollVel) * Math.min(1, real * SCROLL_SMOOTH_PER_S);

    const t = target(ghost.offsetHeight);
    if (t.block !== block) {
      block = t.block;
      react(now);
    }
    const w = width();
    const desiredSide = sideForBlock(t.readBlock, w);
    const resolved = resolveSide(sideState, desiredSide, now);
    if (resolved !== sideState) {
      sideState = resolved;
      crossing = true;
      crossFrom = xs.x;
    }
    const aim = aimFor(reduced.matches, w, sideState.side, block, t.progress);
    pose = aim.pose;
    const tx = aim.x;
    if (crossing && Math.abs(tx - xs.x) <= CROSS_DONE_PX) crossing = false;

    let hopTarget = crossing ? arcLift(crossProgress(crossFrom, tx, xs.x)) : 0;
    if (hopStart >= 0) {
      if (now - hopStart < HOP_SINK_MS) hopTarget += HOP_SINK_PX;
      else if (!hopKicked) {
        hopKicked = true;
        hop.v += HOP_KICK;
      }
    }

    const towardColumn = sideState.side === "right" ? 1 : -1;
    const tiltTarget = pose.tilt + towardColumn * tiltFromVelocity(scrollVel + y.v) + tiltFromHorizontalVelocity(xs.v);
    Object.assign(xs, springStep(xs, tx, dt, SPRINGS.x));
    Object.assign(tilt, springStep(tilt, tiltTarget, dt, SPRINGS.tilt));
    Object.assign(y, springStep(y, t.y, dt, SPRINGS.y));
    Object.assign(scale, springStep(scale, pose.scale, dt, SPRINGS.scale));
    Object.assign(hop, springStep(hop, hopTarget, dt, SPRINGS.hop));
    render();

    const still =
      atRest(xs, tx) &&
      !crossing &&
      sideState.side === desiredSide &&
      atRest(y, t.y) &&
      atRest(tilt, pose.tilt) &&
      atRest(scale, pose.scale) &&
      atRest(hop, 0) &&
      hopKicked &&
      Math.abs(scrollVel) < SCROLL_REST;
    if (still) {
      settle();
      render();
      running = false;
      lastTime = 0;
      hopStart = -1;
      ghost.style.setProperty("--float", String(FLOAT_IDLE));
      return;
    }
    requestAnimationFrame(frame);
  };

  const wake = (): void => {
    if (!wide.matches || reduced.matches || running) return;
    running = true;
    lastScroll = window.scrollY;
    scrollVel = 0;
    ghost.style.setProperty("--float", String(FLOAT_MOVING));
    requestAnimationFrame(frame);
  };

  const place = (): void => {
    layout = measure();
    if (!wide.matches) return;
    if (reduced.matches || !ghost.hasAttribute("data-ready")) {
      settle();
      render();
      ghost.setAttribute("data-ready", "");
      return;
    }
    if (width() !== lastWidth) settle();
    wake();
  };

  window.addEventListener("scroll", wake, { passive: true });
  window.addEventListener("resize", place, { passive: true });
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!running && wide.matches) render();
    },
    { passive: true },
  );

  const list = document.querySelector(".post-list");
  list?.addEventListener("pointerover", (e) => {
    if ((e as PointerEvent).pointerType !== "mouse") return;
    const li = (e.target as Element).closest(".post-list > li");
    const i = li ? [...(list.children as HTMLCollectionOf<Element>)].indexOf(li) : -1;
    hovered = i >= 0 ? i : null;
    wake();
  });
  list?.addEventListener("pointerleave", () => {
    hovered = null;
    wake();
  });

  wide.addEventListener("change", place);
  reduced.addEventListener("change", place);
  new ResizeObserver(place).observe(document.body);
  place();
}
