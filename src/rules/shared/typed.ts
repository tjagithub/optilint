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

const isTyped = (e: ts.Expression, ctx: RuleContext) => TYPED.some((t) => ctx.isType(e, t) === "yes");

/** `Array.from(ta)` or `[...ta]` → `ta` */
function copied(e: ts.Expression) {
  const from = staticCall(e, "Array", "from");
  if (from?.args.length === 1) return from.args[0]!;
  return ts.isArrayLiteralExpression(e) && e.elements.length === 1 && ts.isSpreadElement(e.elements[0]!) ? e.elements[0].expression : undefined;
}

export const typedArrayRoundTrip: RuleDef = {
  name: "typed-array-round-trip",
  impact: "medium",
  tiers: ["typed"],
  description: "`new Uint8Array(Array.from(ta))` or `new Uint8Array([...ta])` → `new Uint8Array(ta)`",
  why: "The plain array in the middle boxes every element and is thrown away. A typed array constructor copies another typed array directly, converting each element the same way.",
  kinds: [K.NewExpression],
  check(node, ctx) {
    const n = node as ts.NewExpression;
    if (!ts.isIdentifier(n.expression) || !TYPED.includes(n.expression.text) || n.arguments?.length !== 1) return;
    const source = copied(unwrap(n.arguments[0]!));
    if (!source || !isTyped(source, ctx)) return;
    ctx.report(n.arguments[0]!, "The typed array is copied into a plain array and back; pass it to the constructor directly.",
      fix("typed", [ctx.replace(n.arguments[0]!, ctx.text(source))]));
  },
};

export const postMessageTransfer: RuleDef = {
  name: "postmessage-transfer",
  impact: "medium",
  tiers: [],
  description: "`postMessage(buffer)` of an ArrayBuffer or typed array without a transfer list",
  why: "Without a transfer list, `postMessage` copies the whole buffer (structured clone). Transferring moves it in constant time: `postMessage(ta, [ta.buffer])` for a worker or port, `postMessage(ta, origin, [ta.buffer])` for a window. The sender's buffer is then detached, so only do it when the sender is done with it.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const call = node as ts.CallExpression;
    const callee = call.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    const [data, second] = call.arguments;
    if (name !== "postMessage" || !data || call.arguments.length > 2) return;
    if (second && ctx.isString(second) !== "yes") return;
    if (!isTyped(data, ctx) && ctx.isType(data, "ArrayBuffer") !== "yes") return;
    const buffer = ctx.isType(data, "ArrayBuffer") === "yes" ? ctx.text(data) : `${ctx.text(data)}.buffer`;
    ctx.report(node, `\`postMessage\` copies the buffer; transfer it with \`[${buffer}]\` if the sender is done with it.`);
  },
};
