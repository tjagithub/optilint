import ts from "typescript";
import {
  enclosingStatement, insideFunction, isFunction, isNumber, isSimpleRef, isStringLit, methodCall, needsParens,
  repeatingAncestor, unwrap,
} from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import { fewIterations, knownSmall } from "../../core/size.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const SEARCH = new Set(["includes", "indexOf", "lastIndexOf", "find", "findIndex", "findLast", "findLastIndex", "some"]);
const STRINGY = new Set(["includes", "indexOf", "lastIndexOf"]);
// Up to this many elements a linear scan costs about what a Set or Map lookup does.
const SMALL = 16;

function rootOf(expr: ts.Expression): ts.Expression {
  const e = unwrap(expr);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return rootOf(e.expression);
  return e;
}

/** The receiver is declared outside `loop`, so a lookup structure could be built once. */
export function invariant(expr: ts.Expression, loop: ts.Node, ctx: RuleContext) {
  const root = rootOf(expr);
  if (root.kind === K.ThisKeyword) return true;
  if (!ts.isIdentifier(root)) return false;
  const decl = ctx.checker.getSymbolAtLocation(root)?.declarations?.[0];
  return !!decl && !(decl.pos >= loop.pos && decl.end <= loop.end);
}

/** `x => x.id === id` (or a single `return` of an equality): a lookup a Map could answer. */
function isEqualityPredicate(fn: ts.Expression | undefined) {
  if (!fn || !isFunction(fn)) return false;
  let body: ts.Node | undefined = fn.body;
  if (ts.isBlock(body)) {
    const [only] = body.statements;
    body = body.statements.length === 1 && only && ts.isReturnStatement(only) ? only.expression : undefined;
  }
  const e = body && unwrap(body as ts.Expression);
  return !!e && ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === K.EqualsEqualsEqualsToken || e.operatorToken.kind === K.EqualsEqualsToken);
}

export const lookupInLoop: RuleDef = {
  name: "lookup-in-loop",
  impact: "high",
  tiers: [],
  description: "Linear search (`includes`/`indexOf`/`find`/`some`) inside a loop",
  why: "A linear search inside a loop makes the whole thing O(n·m). Build a Set or Map once before the loop and each lookup becomes O(1).",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, SEARCH);
    const loop = m && repeatingAncestor(node);
    if (!m || !loop) return;
    const arr = ctx.isArray(m.object);
    if (arr === "no" || (arr === "maybe" && STRINGY.has(m.name))) return;
    if (!STRINGY.has(m.name) && !isEqualityPredicate(m.args[0])) return;
    if (ts.isArrayLiteralExpression(unwrap(m.object)) || !invariant(m.object, loop, ctx) || knownSmall(m.object, ctx, SMALL)) return;
    if (fewIterations(loop, ctx, SMALL)) return;
    const what = STRINGY.has(m.name) ? "a Set" : "a Map keyed by what you match on";
    ctx.report(node, `\`.${m.name}()\` scans the array on every iteration (O(n·m)); build ${what} once outside the loop.`);
  },
};

function setName(x: ts.Expression) {
  const e = unwrap(x);
  const base = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "lookup";
  return `${base.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_SET`;
}

export const arrayLiteralLookup: RuleDef = {
  name: "array-literal-lookup",
  impact: "medium",
  tiers: ["exact"],
  description: "`['a', 'b'].includes(x)` inside a function → `x === 'a' || x === 'b'` or a hoisted Set",
  why: "The array literal is rebuilt on every call and then searched linearly. A few comparisons need no allocation; for longer lists a module-level Set gives O(1) lookups.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, "includes");
    const arr = m && unwrap(m.object);
    if (!m || m.args.length !== 1 || !arr || !ts.isArrayLiteralExpression(arr) || arr.elements.length < 2) return;
    if (!arr.elements.every((e) => isStringLit(e) || ts.isNumericLiteral(e))) return;
    if (!insideFunction(node) && !repeatingAncestor(node)) return;
    const x = m.args[0]!;
    const items = arr.elements.map((e) => ctx.text(e));
    if (items.length <= 6 && isSimpleRef(x)) {
      const xs = ctx.text(x);
      const text = items.map((i) => `${xs} === ${i}`).join(" || ");
      ctx.report(node, "Array literal rebuilt on each call just to search it; compare directly.",
        fix("exact", [ctx.replace(node, needsParens(node, 4) ? `(${text})` : text)]));
      return;
    }
    const stmt = enclosingStatement(node);
    if (!stmt) return;
    const name = ctx.uniqueName(setName(x));
    const comments = ts.getLeadingCommentRanges(ctx.sf.text, stmt.getFullStart());
    const at = comments?.[0]?.pos ?? stmt.getStart(ctx.sf);
    ctx.report(node, "Array literal rebuilt on each call and searched linearly; hoist it into a Set.", fix("exact", [
      { start: at, end: at, text: `const ${name} = new Set([${items.join(", ")}]);\n\n` },
      ctx.replace(node, `${name}.has(${ctx.text(x)})`),
    ]));
  },
};

const MUTATORS: Record<string, string> = {
  shift: "`.shift()` re-indexes the array (O(n) for large arrays); keep a read index instead",
  unshift: "`.unshift()` moves every element (O(n)); push and reverse once, or build in order",
  splice: "`.splice()` moves the tail on every call (O(n)); rebuild with one filter/compaction pass",
};

export const quadraticMutation: RuleDef = {
  name: "quadratic-array-mutation",
  impact: "medium",
  tiers: [],
  description: "`shift`/`unshift`/`splice` inside a loop",
  why: "These move every following element. Inside a loop over the same data that is O(n²); a head index, a reverse, or a single compaction pass is O(n).",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, new Set(Object.keys(MUTATORS)));
    const loop = m && repeatingAncestor(node);
    if (!m || !loop || ctx.isArray(m.object) === "no" || !invariant(m.object, loop, ctx)) return;
    if (m.name === "splice" && m.args.length >= 1 && isNumber(m.args[1], 0) && m.args.length === 2) return;
    ctx.report(node, `${MUTATORS[m.name]}.`);
  },
};

export const lookupRules = [lookupInLoop, arrayLiteralLookup, quadraticMutation];
