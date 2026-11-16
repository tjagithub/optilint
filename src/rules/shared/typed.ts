import ts from "typescript";
import { isSimpleRef, methodCall, staticCall, unwrap } from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const TYPED = [
  "Uint8Array", "Uint8ClampedArray", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
];
// Methods that read the copy and return without running user code.
const READS = new Set(["indexOf", "lastIndexOf", "includes", "join", "at", "toString"]);

function parentOf(node: ts.Node) {
  let p = node.parent;
  while (ts.isParenthesizedExpression(p)) p = p.parent;
  return p;
}

const simple = (args: readonly ts.Expression[]) => args.every((a) => isSimpleRef(a) || ts.isLiteralExpression(unwrap(a)));

/** The copy is read once, right away, with no user code in between, so a view gives the same result. */
function readAtOnce(call: ts.CallExpression, ctx: RuleContext) {
  const p = parentOf(call);
  if (ts.isPropertyAccessExpression(p) && READS.has(p.name.text)) {
    const use = parentOf(p);
    return ts.isCallExpression(use) && use.expression === p && simple(use.arguments);
  }
  if (ts.isSpreadElement(p)) {
    const use = p.parent;
    return ts.isCallExpression(use) && use.arguments.length === 1 &&
      !!(staticCall(use, "Math", "max") ?? staticCall(use, "Math", "min") ?? staticCall(use, "String", "fromCharCode"));
  }
  const decode = methodCall(p, "decode");
  return !!decode && decode.args.length === 1 && ctx.isType(decode.object, "TextDecoder") === "yes";
}

export const typedArraySubarray: RuleDef = {
  name: "typed-array-subarray",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`ta.slice(a, b)` on a typed array → `ta.subarray(a, b)`",
  why: "On a typed array, `slice` allocates a new buffer and copies the elements; `subarray` makes a view over the same memory in constant time. The view shares memory, so it is `typed` only when the result is read right away (`indexOf`, `TextDecoder.decode`, a spread into `Math.max`); otherwise writes to either array would show in the other.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, "slice");
    if (!m || m.args.length > 2 || !TYPED.some((t) => ctx.isType(m.object, t) === "yes")) return;
    const callee = (m.call.expression as ts.PropertyAccessExpression).name;
    const tier = readAtOnce(m.call, ctx) ? "typed" : "assumed";
    ctx.report(node, "`.slice()` copies the typed array; `.subarray()` is a view over the same memory.",
      fix(tier, [ctx.replace(callee, "subarray")], "neither array is written, and the result is not kept, while it is in use"));
  },
};
