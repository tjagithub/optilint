import ts from "typescript";
import { isFunction, isStringLit, methodCall, unwrap } from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";
import { LAYOUT_PROPS } from "./dom.ts";

const K = ts.SyntaxKind;
// Events whose listeners block scrolling until they return, unless marked passive.
const BLOCKING = new Set(["wheel", "mousewheel", "touchstart", "touchmove"]);
const RESIZING = new Set(["scroll", "resize"]);
const LAYOUT_CALLS = new Set(["getBoundingClientRect", "getClientRects", "getComputedStyle"]);

/** `target.addEventListener("type", (e) => ...)` with a function literal, for `types`. */
function listener(node: ts.Node, types: ReadonlySet<string>) {
  const m = methodCall(node, "addEventListener");
  const [type, handler] = m?.args ?? [];
  if (!m || !type || !handler || !isStringLit(type) || !types.has((unwrap(type) as ts.StringLiteralLike).text)) return;
  const fn = unwrap(handler);
  return isFunction(fn) ? { m, fn, handler } : undefined;
}

/** Whether `fn` might cancel the event: it names `preventDefault`, or lets the event escape. */
function mayCancel(fn: ts.ArrowFunction | ts.FunctionExpression) {
  const event = fn.parameters[0]?.name;
  const visit = (n: ts.Node): boolean => {
    if (ts.isIdentifier(n)) {
      if (n.text === "preventDefault" || n.text === "arguments") return true;
      if (event && ts.isIdentifier(event) && n.text === event.text) return !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n);
    }
    return !!ts.forEachChild(n, (c) => visit(c) || undefined);
  };
  return visit(fn.body) || (!!event && !ts.isIdentifier(event) && visit(event));
}

export const passiveListener: RuleDef = {
  name: "passive-listener",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`wheel`/`touchstart`/`touchmove` listener that never calls `preventDefault`, without `{ passive: true }`",
  why: "The browser cannot scroll until a non-passive wheel or touch listener returns, because it might call `preventDefault`. A listener that never does can say so with `{ passive: true }`, and scrolling no longer waits for it.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const l = listener(node, BLOCKING);
    if (!l || l.m.args.length !== 2 || mayCancel(l.fn)) return;
    const tier = ctx.checker.getPropertyOfType(ctx.checker.getTypeAtLocation(l.m.object), "dispatchEvent") ? "typed" : "assumed";
    ctx.report(node, "This listener never calls `preventDefault`; mark it `{ passive: true }` so scrolling does not wait for it.",
      fix(tier, [{ start: l.handler.end, end: l.handler.end, text: ", { passive: true }" }], "the target is a DOM EventTarget"));
  },
};

/** A layout read in `n`, outside any `requestAnimationFrame` callback. */
function readsLayout(n: ts.Node, ctx: RuleContext): boolean {
  const call = ts.isCallExpression(n) ? n.expression : undefined;
  const name = call && (ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call) ? call.name.text : "");
  if (name === "requestAnimationFrame") return false;
  if (name && LAYOUT_CALLS.has(name)) return true;
  if (ts.isPropertyAccessExpression(n) && LAYOUT_PROPS.has(n.name.text) && ctx.isType(n.expression, "Window") !== "yes" &&
    ctx.checker.getPropertyOfType(ctx.checker.getTypeAtLocation(n.expression), "getBoundingClientRect")) return true;
  return !!ts.forEachChild(n, (c) => readsLayout(c, ctx) || undefined);
}

export const scrollLayoutRead: RuleDef = {
  name: "scroll-layout-read",
  impact: "medium",
  tiers: [],
  description: "A `scroll` or `resize` listener that reads layout",
  why: "Scroll and resize fire many times per frame, and each layout read (`getBoundingClientRect`, `offsetTop`) can force a synchronous reflow. `IntersectionObserver` answers visibility questions and `ResizeObserver` size ones without polling; otherwise read once per frame inside `requestAnimationFrame`.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const l = listener(node, RESIZING);
    if (!l || !readsLayout(l.fn.body, ctx)) return;
    ctx.report(node, "This listener reads layout on every event; use `IntersectionObserver` or `ResizeObserver`, or read once per frame.");
  },
};
