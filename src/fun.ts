/* Her reactions, over the whole monitor (gabi.rs): out of the notch and across
 * the screen, then gone. A page of its own because the island can't paint past
 * its window. Nothing here takes a click (Rust keeps the window click-through);
 * only transform and opacity animate.
 *
 * ⚠️ Told where the notch is, on any edge: "down" means away from it.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";

type Fun = "hearts" | "confetti" | "hug" | "stars" | "coffee";
interface Play { fun: Fun; count: number; x: number; y: number; edge: string; serial: number }

const COLOURS = ["#ff5c8a", "#fab219", "#00ff88", "#5b4fe8", "#2f8fe8"];
const random = (from: number, to: number) => from + Math.random() * (to - from);

document.documentElement.style.cssText = "background:transparent;";
document.body.style.cssText = "margin:0;background:transparent;overflow:hidden;";
const layer = document.getElementById("fun")!;
layer.style.cssText = "position:fixed;inset:0;overflow:hidden;pointer-events:none;contain:strict;";

/** "Away from the notch" and "across it", as x/y pairs. */
function axes(edge: string): { away: [number, number]; across: [number, number] } {
  if (edge === "left") return { away: [1, 0], across: [0, 1] };
  if (edge === "right") return { away: [-1, 0], across: [0, 1] };
  if (edge === "bottom") return { away: [0, -1], across: [1, 0] };
  return { away: [0, 1], across: [1, 0] };
}

function spot(text: string | null, size: number): HTMLElement {
  const node = document.createElement("span");
  if (text) {
    node.textContent = text;
    node.style.fontSize = `${size}px`;
  }
  node.style.cssText += "position:absolute;left:0;top:0;line-height:1;will-change:transform,opacity;";
  return node;
}

function animate(node: HTMLElement, frames: Keyframe[], duration: number, delay: number) {
  layer.append(node);
  return node.animate(frames, { duration, delay, easing: "cubic-bezier(0.2, 0, 0.3, 1)", fill: "both" }).finished
    .catch(() => undefined)
    .then(() => node.remove());
}

/** One reaction; answers when the last of it has gone. */
function play(p: Play): Promise<unknown> {
  const W = window.innerWidth, H = window.innerHeight;
  const { away, across } = axes(p.edge);
  const reach = away[0] ? W : H;
  const wide = across[0] ? W : H;
  const at = (a: number, c: number) => `${p.x + away[0] * a + across[0] * c}px, ${p.y + away[1] * a + across[1] * c}px`;
  // More in a row, more in the air (his "one bigger rain"), up to a point.
  const more = Math.min(3, 1 + (p.count - 1) * 0.5);
  const runs: Promise<unknown>[] = [];

  if (p.fun === "hearts" || p.fun === "coffee") {
    const text = p.fun === "hearts" ? "❤️" : "☕";
    const total = Math.round((p.fun === "hearts" ? 34 : 14) * more);
    for (let i = 0; i < total; i++) {
      const side = random(-wide * 0.5, wide * 0.5);
      const fall = random(reach * 0.55, reach * 1.05);
      runs.push(animate(spot(text, random(26, 54)), [
        { transform: `translate(${at(0, 0)}) translate(-50%, -50%) scale(.2)`, opacity: 0 },
        { transform: `translate(${at(random(40, 130), side * 0.4)}) translate(-50%, -50%) scale(1)`, opacity: 1, offset: 0.22 },
        { transform: `translate(${at(fall, side)}) translate(-50%, -50%) scale(1.05) rotate(${random(-25, 25)}deg)`, opacity: 0 },
      ], random(1800, 3100), random(0, 700)));
    }
  } else if (p.fun === "confetti") {
    const total = Math.round(90 * more);
    for (let i = 0; i < total; i++) {
      const w = random(7, 13);
      const side = random(-wide * 0.55, wide * 0.55);
      const node = spot(null, 0);
      node.style.width = `${w}px`;
      node.style.height = `${w * 0.6}px`;
      node.style.borderRadius = "2px";
      node.style.background = COLOURS[Math.floor(random(0, COLOURS.length))];
      runs.push(animate(node, [
        { transform: `translate(${at(0, 0)}) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${at(random(50, 200), side * 0.7)}) rotate(${random(180, 500)}deg)`, opacity: 1, offset: 0.25 },
        { transform: `translate(${at(reach, side)}) rotate(${random(720, 1200)}deg)`, opacity: 0 },
      ], random(2000, 3400), random(0, 450)));
    }
  } else if (p.fun === "hug") {
    const size = Math.min(220, Math.max(120, H * 0.24));
    const middle = `${W / 2}px, ${H / 2}px`;
    runs.push(animate(spot("🤗", size), [
      { transform: `translate(${at(0, 0)}) translate(-50%, -50%) scale(.15)`, opacity: 0 },
      { transform: `translate(${middle}) translate(-50%, -50%) scale(1.12)`, opacity: 1, offset: 0.25 },
      { transform: `translate(${middle}) translate(-50%, -50%) scale(.98)`, opacity: 1, offset: 0.4 },
      { transform: `translate(${middle}) translate(-50%, -50%) scale(1)`, opacity: 1, offset: 0.8 },
      { transform: `translate(${middle}) translate(-50%, -50%) scale(1.25)`, opacity: 0 },
    ], 2400, 0));
  } else {
    const total = Math.round(36 * more);
    for (let i = 0; i < total; i++) {
      const here = `${random(W * 0.03, W * 0.97)}px, ${random(H * 0.05, H * 0.95)}px`;
      runs.push(animate(spot("✨", random(24, 44)), [
        { transform: `translate(${here}) scale(0) rotate(-20deg)`, opacity: 0 },
        { transform: `translate(${here}) scale(${random(0.8, 1.3)}) rotate(0deg)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${here}) scale(0) rotate(20deg)`, opacity: 0 },
      ], random(900, 1700), random(0, 1200)));
    }
  }
  return Promise.all(runs);
}

function start(p: Play) {
  void play(p).then(() => { if (native) void call("gabi_fun_done", { serial: p.serial }).catch(() => {}); });
}

if (native) {
  await listen<Play>("fun:play", event => start(event.payload));
  // ⚠️ After listening: the first reaction is what made this page load at all.
  const first = await call<Play | null>("gabi_fun_ready").catch(() => null);
  if (first) start(first);
} else {
  // The preview: `fun.html?fun=hearts&count=1&edge=top`.
  const q = new URLSearchParams(location.search);
  (window as unknown as { __fun: (fun: Fun, count?: number, edge?: string) => Promise<unknown> }).__fun =
    (fun, count = 1, edge = "top") => play({ fun, count, edge, x: window.innerWidth / 2, y: 40, serial: 0 });
  const fun = q.get("fun") as Fun | null;
  if (fun) start({ fun, count: Number(q.get("count")) || 1, edge: q.get("edge") ?? "top", x: window.innerWidth / 2, y: 40, serial: 0 });
}
