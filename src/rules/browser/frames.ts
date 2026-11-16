import ts from "typescript";
import { identifiersIn, isFunction, methodCall } from "../../core/ast.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const GL = ["WebGLRenderingContext", "WebGL2RenderingContext"];
// Calls that make the CPU wait for the GPU to finish queued work.
const SYNC = new Set(["getError", "getParameter", "readPixels", "checkFramebufferStatus", "getShaderParameter", "getProgramParameter", "finish"]);
const CREATE = new Set(["createBuffer", "createTexture", "createFramebuffer", "createRenderbuffer", "createShader", "createProgram", "createVertexArray"]);
const TYPED_ARRAY = /^(?:Big)?(?:Ui|I)nt(?:8|16|32|64)(?:Clamped)?Array$|^Float(?:16|32|64)Array$/;

function isRaf(call: ts.CallExpression) {
  const c = call.expression;
  return (ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "") === "requestAnimationFrame";
}

function functionName(fn: ts.SignatureDeclaration) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  return ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
}

/** `node` runs once per frame: inside a `requestAnimationFrame` callback, or a function that schedules itself with it. */
function inFrame(node: ts.Node) {
  for (let fn = ts.findAncestor(node.parent, ts.isFunctionLike); fn; fn = ts.findAncestor(fn.parent, ts.isFunctionLike)) {
    if (isFunction(fn) && ts.isCallExpression(fn.parent) && isRaf(fn.parent) && fn.parent.arguments[0] === fn) return true;
    const name = functionName(fn);
    const schedules = (n: ts.Node): boolean =>
      (ts.isCallExpression(n) && isRaf(n) && !!n.arguments[0] && identifiersIn(n.arguments[0]).has(name!)) ||
      !!ts.forEachChild(n, (c) => schedules(c) || undefined);
    if (name && schedules(fn)) return true;
  }
  return false;
}

const isGl = (e: ts.Expression, ctx: RuleContext) => GL.some((t) => ctx.isType(e, t) === "yes");

export const gpuSyncInFrame: RuleDef = {
  name: "gpu-sync-in-frame",
  impact: "high",
  tiers: [],
  description: "`gl.getError()`, `getParameter`, `readPixels` and other GPU round trips inside a frame callback",
  why: "WebGL calls are queued for the GPU. A query such as `getError` or `readPixels` makes the CPU wait until the queue drains, every frame, which stalls the pipeline. Check errors only in debug builds, cache parameters at start-up, and read pixels asynchronously (a pixel buffer and `fenceSync` in WebGL2).",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, SYNC);
    if (!m || !isGl(m.object, ctx) || !inFrame(node)) return;
    ctx.report(node, `\`${m.name}\` waits for the GPU on every frame; move it out of the render loop.`);
  },
};

export const perFrameAllocation: RuleDef = {
  name: "per-frame-allocation",
  impact: "medium",
  tiers: [],
  description: "WebGL objects, canvas contexts or typed arrays created inside a frame callback",
  why: "Creating GPU buffers and textures, looking up a canvas context, or allocating typed arrays on every frame churns GPU memory and the garbage collector, which shows up as dropped frames. Create them once and reuse them (`bufferSubData`, `texSubImage2D`, a scratch typed array).",
  kinds: [K.CallExpression, K.NewExpression],
  check(node, ctx) {
    let what: string | undefined;
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && TYPED_ARRAY.test(node.expression.text)) what = `\`new ${node.expression.text}\``;
    } else {
      const m = methodCall(node);
      if (m && CREATE.has(m.name) && isGl(m.object, ctx)) what = `\`${m.name}\``;
      if (m?.name === "getContext" && ["HTMLCanvasElement", "OffscreenCanvas"].some((t) => ctx.isType(m.object, t) === "yes")) what = "`getContext`";
    }
    if (!what || !inFrame(node)) return;
    ctx.report(node, `${what} on every frame; create it once and reuse it.`);
  },
};
