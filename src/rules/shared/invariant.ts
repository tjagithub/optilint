import ts from "typescript";
import { isAssignedIn, isAssignment, methodCall, repeatingAncestor, staticCall, unwrap } from "../../core/ast.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";
import { invariant } from "./lookup.ts";

const K = ts.SyntaxKind;
// Reads that flatten a rope string into one buffer (V8 String::Flatten, JSC resolveRope).
const FLATTENING = new Set([
  "charCodeAt", "codePointAt", "charAt", "at", "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith",
  "search", "match", "localeCompare", "normalize",
]);

function isName(e: ts.Expression, name: string) {
  const u = unwrap(e);
  return ts.isIdentifier(u) && u.text === name;
}

/** Any node under `root` (into arrow callbacks) for which `pred` holds. */
function find(root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node | undefined {
  return ts.forEachChild(root, (c) => (pred(c) ? c : ts.isFunctionLike(c) && !ts.isArrowFunction(c) ? undefined : find(c, pred)));
}

export const stringFlattenInLoop: RuleDef = {
  name: "string-flatten-in-loop",
  impact: "high",
  tiers: [],
  description: "A string grown with `+=` and searched or indexed in the same loop",
  why: "`s += x` builds a rope, which is cheap. A read such as `s.charCodeAt(i)`, `s[i]` or `s.indexOf(x)` flattens the rope into one buffer, copying the whole string. Doing both in each iteration copies the string every time: O(n²). Keep what you need to read in a separate variable, or collect parts in an array and `join` once.",
  kinds: [K.BinaryExpression],
  check(node, ctx) {
    const b = node as ts.BinaryExpression;
    if (b.operatorToken.kind !== K.PlusEqualsToken || !ts.isIdentifier(b.left) || ctx.isString(b.left) !== "yes") return;
    const loop = repeatingAncestor(node);
    if (!loop) return;
    const name = b.left.text;
    const read = find(loop, (n) => {
      const m = methodCall(n, FLATTENING);
      if (m) return isName(m.object, name);
      return ts.isElementAccessExpression(n) && isName(n.expression, name) && !(isAssignment(n.parent) && n.parent.left === n);
    });
    if (!read) return;
    const what = ts.isElementAccessExpression(read) ? `\`${name}[…]\`` : `\`.${methodCall(read)!.name}()\``;
    ctx.report(node, `\`${name}\` grows with \`+=\` and is read with ${what} in the same loop; each read copies the whole string (O(n²)).`);
  },
};

/** `node` is part of a `return` or `throw` inside `loop`, so it runs once. */
function exitsWith(node: ts.Node, loop: ts.Node) {
  for (let p = node.parent; p && p !== loop; p = p.parent) if (ts.isReturnStatement(p) || ts.isThrowStatement(p)) return true;
  return false;
}

/** Every identifier in `args` is declared outside `loop` and not assigned in it; calls must take arguments. */
export function invariantArgs(args: readonly ts.Expression[], loop: ts.Node, ctx: RuleContext) {
  const names: string[] = [];
  const varies = (n: ts.Node): boolean => {
    if (ts.isCallExpression(n) && n.arguments.length === 0) return true;
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      names.push(n.text);
      return !invariant(n, loop, ctx);
    }
    return !!ts.forEachChild(n, (c) => varies(c) || undefined);
  };
  return !args.some(varies) && names.length > 0 && !isAssignedIn(loop, names);
}

export const regexpInLoop: RuleDef = {
  name: "regexp-in-loop",
  impact: "low",
  tiers: [],
  description: "`new RegExp(x)` with the same `x` on every iteration of a loop",
  why: "The pattern does not change between iterations, but each `new RegExp` allocates an object and looks the pattern up in the engine's regexp cache. Build it once before the loop. A hoisted regexp with the `g` or `y` flag keeps `lastIndex` between uses, so reset it or use `String.prototype.match`/`replace`, which do.",
  kinds: [K.NewExpression, K.CallExpression],
  check(node, ctx) {
    const call = node as ts.NewExpression | ts.CallExpression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "RegExp") return;
    const args = call.arguments ?? [];
    if (!args.length || args.every((a) => ts.isStringLiteralLike(unwrap(a)))) return;
    const loop = repeatingAncestor(node);
    if (!loop || !invariantArgs(args, loop, ctx) || exitsWith(node, loop)) return;
    ctx.report(node, "The same `RegExp` is built on every iteration; build it once before the loop.");
  },
};

const KEYS = ["keys", "values", "entries", "getOwnPropertyNames"];

/** Whether `loop` may change the keys of the object named `root`. */
function writesTo(loop: ts.Node, root: string) {
  const rootOf = (e: ts.Expression): ts.Expression => {
    const u = unwrap(e);
    return ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u) ? rootOf(u.expression) : u;
  };
  return isAssignedIn(loop, [root]) || !!find(loop, (n) =>
    (isAssignment(n) && isName(rootOf(n.left), root) && n.left !== rootOf(n.left)) ||
    (ts.isDeleteExpression(n) && isName(rootOf(n.expression), root)) ||
    (ts.isCallExpression(n) && n.arguments.some((a) => isName(a, root)) && !KEYS.some((k) => staticCall(n, "Object", k))) ||
    (methodCall(n) !== undefined && isName(rootOf(methodCall(n)!.object), root)));
}

export const objectKeysInLoop: RuleDef = {
  name: "object-keys-in-loop",
  impact: "medium",
  tiers: [],
  description: "`Object.keys(o)` (or values/entries) of an unchanged object inside a loop",
  why: "Each call allocates a fresh array of every key (and, for entries, a pair per key). When the loop never changes the object, the result is the same every time: compute it once before the loop. In a loop condition (`i < Object.keys(o).length`) it is rebuilt on every iteration.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = KEYS.map((k) => staticCall(node, "Object", k)).find(Boolean);
    const arg = m?.args.length === 1 ? m.args[0]! : undefined;
    const loop = arg && repeatingAncestor(node);
    if (!m || !arg || !loop || !invariantArgs([arg], loop, ctx)) return;
    let root = unwrap(arg);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
    if (!ts.isIdentifier(root) || writesTo(loop, root.text)) return;
    ctx.report(node, `\`Object.${m.name}(${ctx.text(arg)})\` is rebuilt on every iteration though the object does not change; compute it once before the loop.`);
  },
};


