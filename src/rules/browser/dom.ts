import ts from "typescript";
import { repeatingAncestor } from "../../core/ast.ts";
import type { RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

const DOM_QUERIES = new Set([
  "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName", "getElementsByTagName",
  "getElementsByName", "getComputedStyle", "getBoundingClientRect", "getClientRects",
]);
const LAYOUT_PROPS = new Set([
  "offsetWidth", "offsetHeight", "offsetTop", "offsetLeft", "clientWidth", "clientHeight", "clientTop",
  "clientLeft", "scrollWidth", "scrollHeight", "scrollTop", "scrollLeft", "innerText",
]);

export const domInLoop: RuleDef = {
  name: "dom-in-loop",
  impact: "high",
  tiers: [],
  description: "DOM queries and layout reads inside loops",
  why: "Querying the DOM walks the tree. Layout reads such as offsetHeight or getBoundingClientRect force a synchronous reflow when styles are dirty, and interleaving them with writes in a loop causes layout thrashing. Query once and batch reads before writes.",
  kinds: [K.CallExpression, K.PropertyAccessExpression],
  check(node, ctx) {
    if (!repeatingAncestor(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (DOM_QUERIES.has(name)) ctx.report(node, `\`${name}()\` inside a loop; query or measure once outside it.`);
      return;
    }
    const n = node as ts.PropertyAccessExpression;
    if (!LAYOUT_PROPS.has(n.name.text) || ctx.isType(n.expression, "Window") === "yes") return;
    const t = ctx.checker.getTypeAtLocation(n.expression);
    const isElement = ctx.checker.getPropertyOfType(t, "getBoundingClientRect") !== undefined;
    if (isElement) ctx.report(n, `Reading \`${n.name.text}\` in a loop can force a synchronous layout per iteration.`);
  },
};
