import { makeStars } from "../lib/world";
import { initGhost } from "./ghost";

type Theme = "light" | "dark";

function rememberTheme(theme: Theme): void {
  try {
    localStorage.setItem("theme", theme);
  } catch {
    return;
  }
}

function initTheme(): void {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

  const apply = (theme: Theme): void => {
    root.setAttribute("data-theme", theme);
    toggle?.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    meta?.setAttribute("content", getComputedStyle(document.body).backgroundColor);
    window.dispatchEvent(new Event("themechange"));
  };

  apply(root.getAttribute("data-theme") === "light" ? "light" : "dark");

  toggle?.addEventListener("click", () => {
    const next: Theme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply(next);
    rememberTheme(next);
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

export function initWorld(): void {
  initTheme();
  initStars();
  initGhost();
}
