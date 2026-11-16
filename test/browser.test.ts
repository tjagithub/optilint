import { describe, expect, test } from "bun:test";
import { fixed, run } from "./helpers.ts";

const lines = (code: string, rule: string) => run(code, { rule }).findings.map((f) => f.line);
const GL = "declare const gl: WebGL2RenderingContext; declare const canvas: HTMLCanvasElement;\n";

describe("passive-listener", () => {
  const R = "passive-listener";
  test("adds { passive: true } to wheel and touch listeners that never cancel", () => {
    const code = "window.addEventListener(\"wheel\", (e) => { console.log(e.deltaY); });";
    expect(fixed(code, R)).toBe("window.addEventListener(\"wheel\", (e) => { console.log(e.deltaY); }, { passive: true });");
    expect(run(code, { rule: R }).findings[0]?.fix?.tier).toBe("typed");
  });
  test("skips listeners that cancel, pass the event on, already have options, or other events", () => {
    const code = `declare function handle(e: Event): void;
document.addEventListener("touchmove", (e) => e.preventDefault());
document.addEventListener("touchstart", (e) => handle(e));
document.addEventListener("wheel", function () { arguments[0].preventDefault(); });
document.addEventListener("wheel", () => {}, { passive: false });
document.addEventListener("click", () => {});`;
    expect(lines(code, R)).toEqual([]);
  });
  test("assumed when the target is not known to be a DOM EventTarget", () => {
    const code = "declare const bus: any;\nbus.addEventListener('wheel', () => {});";
    expect(run(code, { rule: R }).findings[0]?.fix?.tier).toBe("assumed");
  });
});

describe("scroll-layout-read", () => {
  const R = "scroll-layout-read";
  test("flags scroll and resize listeners that read layout", () => {
    const code = `declare const el: HTMLElement;
window.addEventListener("scroll", () => { if (el.getBoundingClientRect().top < 0) {} });
window.addEventListener("resize", () => el.offsetWidth);`;
    expect(lines(code, R)).toEqual([2, 3]);
  });
  test("skips reads inside requestAnimationFrame and window scroll position", () => {
    const code = `declare const el: HTMLElement;
window.addEventListener("scroll", () => requestAnimationFrame(() => el.getBoundingClientRect()));
window.addEventListener("scroll", () => window.scrollTop);`;
    expect(lines(code, R)).toEqual([]);
  });
});

describe("frame callbacks", () => {
  test("gpu-sync-in-frame flags GPU round trips once per frame only", () => {
    const code = `${GL}gl.getError();
requestAnimationFrame(() => { gl.getError(); });
function draw() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, null); requestAnimationFrame(draw); }`;
    expect(lines(code, "gpu-sync-in-frame")).toEqual([3, 4]);
  });
  test("per-frame-allocation flags GL objects, contexts and typed arrays made per frame", () => {
    const code = `${GL}const scratch = new Float32Array(16);
const loop = () => { gl.createBuffer(); canvas.getContext("2d"); new Float32Array(16); requestAnimationFrame(loop); };
function setup() { gl.createTexture(); }`;
    expect(lines(code, "per-frame-allocation")).toEqual([3, 3, 3]);
  });
});
