import { GHOST_W, gaze, ghostTop, ghostX, makeStars, scrollProgress, WIDE_MIN } from "../lib/world";

type Theme = "light" | "dark";

function initTheme(): void {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

  const apply = (theme: Theme): void => {
    root.setAttribute("data-theme", theme);
    toggle?.setAttribute("aria-label", theme === "dark" ? "ライトテーマに切り替え" : "ダークテーマに切り替え");
    meta?.setAttribute("content", getComputedStyle(document.body).backgroundColor);
    window.dispatchEvent(new Event("themechange"));
  };

  apply(root.getAttribute("data-theme") === "light" ? "light" : "dark");

  toggle?.addEventListener("click", () => {
    const next: Theme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // 保存できなくても、この訪問の間は選んだテーマのまま
    }
  });
}

function initStars(): void {
  const canvas = document.querySelector<HTMLCanvasElement>(".starfield");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  const stars = makeStars();

  const draw = (): void => {
    const style = getComputedStyle(document.documentElement);
    const rgb = style.getPropertyValue("--star").trim().replace(/\s+/g, ", ");
    const gain = Number(style.getPropertyValue("--star-a")) || 1;
    const dpr = window.devicePixelRatio || 1;
    const { innerWidth: w, innerHeight: h } = window;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      ctx.fillStyle = `rgba(${rgb}, ${s.a * gain})`;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  let frame = 0;
  window.addEventListener(
    "resize",
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    },
    { passive: true },
  );
  window.addEventListener("themechange", draw);
  draw();
}

const PUPIL_REACH = 8;

function initGhost(): void {
  const ghost = document.querySelector<HTMLElement>(".ghost-float");
  if (!ghost) return;

  const wide = window.matchMedia(`(min-width: ${WIDE_MIN}px)`);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine) and (prefers-reduced-motion: no-preference)");
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;

  const update = (): void => {
    frame = 0;
    if (!wide.matches) return;
    const root = document.documentElement;
    const maxScroll = root.scrollHeight - window.innerHeight;
    const progress = scrollProgress(window.scrollY, maxScroll);
    const h = ghost.offsetHeight;
    // 動きを減らす設定では位置を追従させず、上の位置に留める。視線だけは進み具合に合わせる
    const top = ghostTop(reduced.matches ? 0 : progress, window.innerHeight, h);
    const x = ghostX(root.clientWidth);
    ghost.style.transform = `translate(${x - GHOST_W / 2}px, ${top}px)`;

    const cursor =
      pointer && finePointer.matches ? { dx: pointer.x - x, dy: pointer.y - (top + h / 2) } : null;
    const eyes = gaze(progress, cursor, PUPIL_REACH);
    ghost.style.setProperty("--gx", eyes.x.toFixed(2));
    ghost.style.setProperty("--gy", eyes.y.toFixed(2));
    ghost.dataset.ready = "";
  };

  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      schedule();
    },
    { passive: true },
  );
  wide.addEventListener("change", schedule);
  reduced.addEventListener("change", schedule);
  // 画像の読み込みなどでページの長さが変わると、進み具合も変わる
  new ResizeObserver(schedule).observe(document.body);
  update();
}

export function initWorld(): void {
  initTheme();
  initStars();
  initGhost();
}
