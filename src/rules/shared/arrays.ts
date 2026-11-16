import ts from "typescript";
import { asMemberTarget, isBooleanContext, isFunction, isNumber, methodCall, staticCall, unwrap } from "../../core/ast.ts";
import { byType, fix } from "../../core/fix.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

const ARRAY = "the receiver is an array";
/** Global functions that read only their first argument. */
const ONE_ARG = new Set(["Boolean", "Number", "String"]);

function rewriteMethod(ctx: RuleContext, node: ts.Node, object: ts.Expression, name: string, args: readonly ts.Expression[], negate = false) {
  const target = asMemberTarget(object, ctx.text(object));
  return ctx.replace(node, `${negate ? "!" : ""}${target}.${name}(${args.map((a) => ctx.text(a)).join(", ")})`);
}

export const filterFirst: RuleDef = {
  name: "filter-first",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`xs.filter(f)[0]` → `xs.find(f)`",
  why: "filter visits every element and allocates a new array; find stops at the first match and allocates nothing.",
  kinds: [K.ElementAccessExpression],
  check(node, ctx) {
    const n = node as ts.ElementAccessExpression;
    const m = methodCall(n.expression, "filter");
    if (!m || !isNumber(n.argumentExpression, 0) || n.questionDotToken) return;
    const tier = byType(ctx.isArray(m.object));
    if (!tier) return;
    ctx.report(n, "`.filter(...)[0]` scans the whole array; use `.find(...)`.", fix(tier, [rewriteMethod(ctx, n, m.object, "find", m.args)], ARRAY));
  },
};

const POSITIVE = new Map<ts.SyntaxKind, number>([
  [K.GreaterThanToken, 0], [K.ExclamationEqualsEqualsToken, 0], [K.ExclamationEqualsToken, 0],
  [K.GreaterThanEqualsToken, 1],
]);
const NEGATIVE = new Map<ts.SyntaxKind, number>([
  [K.EqualsEqualsEqualsToken, 0], [K.EqualsEqualsToken, 0], [K.LessThanToken, 1], [K.LessThanEqualsToken, 0],
]);

function filterLength(expr: ts.Expression) {
  const e = unwrap(expr);
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "length" || e.questionDotToken) return;
  return methodCall(e.expression, "filter");
}

export const filterLengthToSome: RuleDef = {
  name: "filter-length-to-some",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`xs.filter(f).length > 0` → `xs.some(f)`",
  why: "Counting matches allocates an array and visits every element; some() short-circuits on the first match.",
  kinds: [K.BinaryExpression, K.PropertyAccessExpression],
  check(node, ctx) {
    let m, negate = false;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      m = filterLength(node.left);
      if (!m) return;
      if (isNumber(node.right, POSITIVE.get(op) ?? NaN)) negate = false;
      else if (isNumber(node.right, NEGATIVE.get(op) ?? NaN)) negate = true;
      else return;
    } else {
      if (!isBooleanContext(node)) return;
      m = filterLength(node as ts.Expression);
      if (!m) return;
    }
    const tier = byType(ctx.isArray(m.object));
    if (!tier) return;
    ctx.report(node, "Checking `.filter(...).length` builds an array just to test for a match; use `.some(...)`.",
      fix(tier, [rewriteMethod(ctx, node, m.object, "some", m.args, negate)], ARRAY));
  },
};

export const mapFlat: RuleDef = {
  name: "map-flat-to-flatmap",
  impact: "low",
  tiers: ["typed", "assumed"],
  description: "`xs.map(f).flat()` → `xs.flatMap(f)`",
  why: "flatMap does one pass and skips the intermediate array.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const flat = methodCall(node, "flat");
    if (!flat || flat.args.length > 1 || (flat.args[0] && !isNumber(flat.args[0], 1))) return;
    const map = methodCall(flat.object, "map");
    if (!map) return;
    const tier = byType(ctx.isArray(map.object));
    if (!tier || !ctx.hasMember(map.object, "flatMap")) return;
    ctx.report(node, "`.map(...).flat()` allocates an intermediate array; use `.flatMap(...)`.",
      fix(tier, [rewriteMethod(ctx, node, map.object, "flatMap", map.args)], ARRAY));
  },
};

export const unusedMap: RuleDef = {
  name: "unused-map",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`xs.map(f);` with the result ignored → `xs.forEach(f)`",
  why: "map allocates and fills a result array that nobody reads.",
  kinds: [K.ExpressionStatement],
  check(node, ctx) {
    const m = methodCall((node as ts.ExpressionStatement).expression, "map");
    if (!m) return;
    const tier = byType(ctx.isArray(m.object));
    if (!tier) return;
    const name = (m.call.expression as ts.PropertyAccessExpression).name;
    ctx.report(m.call, "The result of `.map(...)` is unused; use a loop or `.forEach(...)`.", fix(tier, [ctx.replace(name, "forEach")], ARRAY));
  },
};

export const arrayFromMap: RuleDef = {
  name: "array-from-map",
  impact: "low",
  tiers: ["typed", "assumed"],
  retired: "the fix is slower on every V8 and JSC tier (TurboFan 0.12–0.15x); see bench/FINDINGS.md, 2026-11-16",
  description: "`Array.from(x).map(f)` → `Array.from(x, f)`",
  why: "Array.from takes a map function, which avoids building the array twice.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const map = methodCall(node, "map");
    const from = map && staticCall(map.object, "Array", "from");
    if (!map || !from || from.args.length !== 1 || map.args.length !== 1) return;
    const fn = map.args[0]!;
    const tier = isFunction(fn) && fn.parameters.length < 3 ? "typed" : "assumed";
    ctx.report(node, "`Array.from(x).map(f)` builds two arrays; pass `f` to `Array.from(x, f)`.",
      fix(tier, [ctx.replace(node, `Array.from(${ctx.text(from.args[0]!)}, ${ctx.text(fn)})`)], "`f` does not use its third (array) argument"));
  },
};

const NON_MUTATING = new Set([
  "map", "filter", "forEach", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast",
  "findLastIndex", "includes", "indexOf", "lastIndexOf", "join", "flatMap", "flat", "at", "concat",
  "slice", "toSorted", "toReversed", "toSpliced", "with", "entries", "keys", "values",
]);

/** `[...xs]` or `xs.slice()` → `xs` */
function copiedArray(expr: ts.Expression) {
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e) && e.elements.length === 1 && ts.isSpreadElement(e.elements[0]!)) {
    return e.elements[0].expression;
  }
  const slice = methodCall(e, "slice");
  if (slice && (slice.args.length === 0 || (slice.args.length === 1 && isNumber(slice.args[0], 0)))) {
    return slice.object;
  }
}

export const redundantCopy: RuleDef = {
  name: "redundant-array-copy",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`[...xs].map(f)` → `xs.map(f)` for non-mutating methods",
  why: "Copying an array before a method that does not mutate it costs an O(n) allocation for nothing.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, NON_MUTATING);
    const source = m && copiedArray(m.object);
    if (!m || !source || ctx.isArray(source) !== "yes") return;
    const cb = m.args[0];
    // A callback that is not written inline may read its third argument, which would now be the original.
    const known = !cb || (isFunction(cb) && cb.parameters.length < 3) || (ts.isIdentifier(cb) && ONE_ARG.has(cb.text));
    const tier = known ? "typed" : "assumed";
    ctx.report(m.object, `The array is copied before \`.${m.name}()\`, which does not mutate it.`,
      fix(tier, [ctx.replace(m.object, asMemberTarget(source, ctx.text(source)))], "the callback does not use its third (array) argument"));
  },
};

const CHAIN_FIRST = new Set(["map", "filter", "flatMap"]);
const CHAIN_NEXT = new Set(["map", "filter", "flatMap", "reduce", "forEach", "some", "every", "find", "findIndex", "join"]);

export const chainedMethods: RuleDef = {
  name: "chained-array-methods",
  impact: "medium",
  tiers: [],
  description: "`xs.filter(f).map(g)` chains allocate an array per step",
  why: "Each map/filter step allocates a full intermediate array and walks it again. One loop (or one reduce) does it in a single pass.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const outer = methodCall(node, CHAIN_NEXT);
    const inner = outer && methodCall(unwrap(outer.object), CHAIN_FIRST);
    if (!outer || !inner || ctx.isArray(inner.object) === "no") return;
    if (methodCall(node.parent?.parent, CHAIN_NEXT)?.object === node) return;
    ctx.report(node, `\`.${inner.name}(...).${outer.name}(...)\` builds an intermediate array; fuse into one loop.`);
  },
};

const SORTS = new Set(["sort", "toSorted"]);

export const sortForExtremum: RuleDef = {
  name: "sort-for-extremum",
  impact: "medium",
  tiers: [],
  description: "`xs.sort()[0]` to find a min/max",
  why: "Sorting is O(n log n) (and sort() mutates); finding the min or max is a single O(n) pass.",
  kinds: [K.ElementAccessExpression, K.CallExpression],
  check(node, ctx) {
    let sorted: ts.Expression | undefined;
    if (ts.isElementAccessExpression(node)) {
      const arg = unwrap(node.argumentExpression);
      const last = ts.isBinaryExpression(arg) && arg.operatorToken.kind === K.MinusToken && isNumber(arg.right, 1);
      if (isNumber(arg, 0) || last) sorted = node.expression;
    } else {
      const m = methodCall(node, new Set(["at", "pop", "shift"]));
      if (m && (m.name !== "at" || isNumber(m.args[0], 0) || isNumber(m.args[0], -1))) sorted = m.object;
    }
    const s = sorted && methodCall(unwrap(sorted), SORTS);
    if (!s || ctx.isArray(s.object) === "no") return;
    ctx.report(node, "Sorting to pick the first/last element is O(n log n); a single min/max pass is O(n).");
  },
};

export const minMaxSpread: RuleDef = {
  name: "math-minmax-spread",
  impact: "medium",
  tiers: [],
  description: "`Math.max(...xs)` on large arrays",
  why: "Spreading pushes every element onto the stack: slow for big arrays and a RangeError past ~100k elements. A loop is faster and safe.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = staticCall(node, "Math", "max") ?? staticCall(node, "Math", "min");
    if (!m || m.args.length !== 1 || !ts.isSpreadElement(m.args[0]!)) return;
    ctx.report(node, `\`Math.${m.name}(...xs)\` passes every element as an argument; use a loop for large arrays.`);
  },
};

export const arrayRules = [
  filterFirst, filterLengthToSome, mapFlat, unusedMap, arrayFromMap, redundantCopy,
  chainedMethods, sortForExtremum, minMaxSpread,
];
