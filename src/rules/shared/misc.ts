import ts from "typescript";
import { isNumber, methodCall, needsParens, staticCall, unwrap } from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import type { RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

function isNewDate(expr: ts.Expression | undefined) {
  const e = expr && unwrap(expr);
  return !!e && ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Date" &&
    !e.arguments?.length;
}

export const dateNow: RuleDef = {
  name: "date-now",
  impact: "low",
  tiers: ["exact"],
  description: "`new Date().getTime()` / `+new Date()` → `Date.now()`",
  why: "Date.now() returns the timestamp without allocating a Date object.",
  kinds: [K.CallExpression, K.PrefixUnaryExpression],
  check(node, ctx) {
    let hit = false;
    if (ts.isPrefixUnaryExpression(node)) hit = node.operator === K.PlusToken && isNewDate(node.operand);
    else if (ts.isCallExpression(node)) {
      const m = methodCall(node, new Set(["getTime", "valueOf"]));
      const num = ts.isIdentifier(node.expression) && node.expression.text === "Number" && node.arguments.length === 1;
      hit = (!!m && !m.args.length && isNewDate(m.object)) || (num && isNewDate(node.arguments[0]));
    }
    if (hit) ctx.report(node, "Allocates a Date just to read the time; use `Date.now()`.", fix("exact", [ctx.replace(node, "Date.now()")]));
  },
};

export const powToMul: RuleDef = {
  name: "math-pow-to-mul",
  impact: "low",
  tiers: ["typed", "assumed"],
  description: "`Math.pow(x, 2)` / `x ** 2` → `x * x`",
  why: "Squaring with a multiply is one instruction, while pow goes through the generic power routine (or a builtin call in lower tiers). The results are bit-identical for numbers.",
  kinds: [K.CallExpression, K.BinaryExpression],
  check(node, ctx) {
    let base: ts.Expression | undefined;
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === K.AsteriskAsteriskToken && isNumber(node.right, 2)) base = node.left;
    } else {
      const m = staticCall(node, "Math", "pow");
      if (m && m.args.length === 2 && isNumber(m.args[1], 2)) base = m.args[0];
    }
    const b = base && unwrap(base);
    if (!b || !ts.isIdentifier(b)) return;
    const tier = ctx.checker.getTypeAtLocation(b).flags & ts.TypeFlags.NumberLike ? "typed" : "assumed";
    const text = `${b.text} * ${b.text}`;
    ctx.report(node, "Square with a multiply instead of pow.",
      fix(tier, [ctx.replace(node, needsParens(node, 13) ? `(${text})` : text)], `\`${b.text}\` is a number (not a bigint or an object with valueOf)`));
  },
};

export const bitwiseTrunc: RuleDef = {
  name: "bitwise-trunc",
  impact: "low",
  tiers: ["assumed"],
  recommended: false,
  obscure: true,
  description: "`Math.trunc(x)` / `Math.floor(x)` → `x | 0` (int32 only)",
  why: "`x | 0` truncates to a 32-bit integer in one instruction and tells the JIT the value is a small integer, which keeps the arithmetic after it in int32. It is wrong outside ±2³¹ and for negative values with floor, so the fix is unsafe: only use it where you know the range.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = staticCall(node, "Math", "trunc") ?? staticCall(node, "Math", "floor");
    if (!m || m.args.length !== 1 || ts.isSpreadElement(m.args[0]!)) return;
    const arg = m.args[0]!;
    if (/\bDate\b|getTime|performance\.now|hrtime|timestamp/i.test(ctx.text(arg))) return;
    const inner = ts.isBinaryExpression(unwrap(arg)) || ts.isConditionalExpression(unwrap(arg)) ? `(${ctx.text(arg)})` : ctx.text(arg);
    const text = `${inner} | 0`;
    const note = m.name === "floor" ? " (differs for negative values)" : "";
    const range = m.name === "floor" ? "[0, 2³¹)" : "(-2³¹, 2³¹)";
    ctx.report(node, `\`Math.${m.name}\` → \`| 0\` if the value fits in int32${note}.`,
      fix("assumed", [ctx.replace(node, needsParens(node, 6) ? `(${text})` : text)], `the value is a finite number in ${range}`, true));
  },
};

export const dynamicCode: RuleDef = {
  name: "dynamic-code",
  impact: "high",
  tiers: [],
  description: "`eval`, `new Function`, and `with`",
  why: "Direct eval and `with` make every variable in the enclosing scopes dynamically resolvable, which blocks inlining and register allocation for those functions. new Function re-parses and compiles its source on every call.",
  kinds: [K.CallExpression, K.NewExpression, K.WithStatement],
  check(node, ctx) {
    if (ts.isWithStatement(node)) return ctx.report(node, "`with` makes scope lookups dynamic and blocks optimization.");
    const callee = (node as ts.CallExpression | ts.NewExpression).expression;
    if (!ts.isIdentifier(callee)) return;
    if (callee.text === "eval" && ts.isCallExpression(node)) ctx.report(node, "Direct `eval` deoptimizes every enclosing scope.");
    if (callee.text === "Function") ctx.report(node, "`Function(...)` compiles code at run time; define the function statically.");
  },
};

/** Whether this use of `arguments` makes the engine build the object. */
function escapes(id: ts.Identifier) {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name.text === "length") return isWritten(p);
  if (ts.isElementAccessExpression(p) && p.expression === id) return isWritten(p);
  const apply = ts.isCallExpression(p) && p.arguments[1] === id && p.arguments.length === 2 ? methodCall(p, "apply") : undefined;
  return !apply;
}

function isWritten(e: ts.Expression) {
  const p = e.parent;
  return (ts.isBinaryExpression(p) && p.left === e && p.operatorToken.kind >= K.FirstAssignment && p.operatorToken.kind <= K.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === K.PlusPlusToken || p.operator === K.MinusMinusToken)) ||
    ts.isDeleteExpression(p);
}

export const argumentsObject: RuleDef = {
  name: "arguments-object",
  impact: "low",
  tiers: [],
  description: "`arguments` that escapes, or is written → rest parameters",
  why: "Optimizing compilers never allocate `arguments` when the function only reads `arguments.length` or `arguments[i]`, or passes it to `f.apply(this, arguments)`. Passing it anywhere else, storing it, or writing to it forces a real object (in sloppy mode one that aliases the parameters). Rest parameters give a real array and are always cheap.",
  kinds: [K.Identifier],
  check(node, ctx) {
    const id = node as ts.Identifier;
    if (id.text !== "arguments" || ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) return;
    if (ctx.checker.getSymbolAtLocation(id)?.valueDeclaration || !escapes(id)) return;
    ctx.report(id, "`arguments` escapes here, so the engine must allocate it; use rest parameters (`...args`).");
  },
};
