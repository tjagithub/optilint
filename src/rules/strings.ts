import ts from "typescript";
import {
  asMemberTarget, insideFunction, isBooleanContext, isNumber, isStringLit, methodCall, needsParens,
  repeatingAncestor, unwrap,
} from "../ast.ts";
import { hasNestedQuantifier, plainPattern, splitLiteral, toLiteralBody } from "../regex.ts";
import { byType, fix } from "../fix.ts";
import type { RuleContext, RuleDef } from "../types.ts";

const STRING = "the receiver is a string";

const K = ts.SyntaxKind;

function member(ctx: RuleContext, expr: ts.Expression) {
  return asMemberTarget(expr, ctx.text(expr));
}

export const splitJoin: RuleDef = {
  name: "split-join-to-replaceall",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`s.split(a).join(b)` → `s.replaceAll(a, b)`",
  why: "split/join allocates an array of every piece and then concatenates them again. replaceAll does a single pass. (Needs ES2021.)",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const join = methodCall(node, "join");
    const split = join && methodCall(unwrap(join.object), "split");
    if (!join || !split || split.args.length !== 1 || join.args.length > 1) return;
    const sep = split.args[0];
    if (!isStringLit(sep) || !sep.text) return;
    const tier = byType(ctx.isString(split.object));
    if (!tier) return;
    const rep = join.args[0];
    const message = "`.split(x).join(y)` builds a temporary array; use `.replaceAll(x, y)`.";
    if (rep && !(isStringLit(rep) && !rep.text.includes("$"))) return ctx.report(node, message);
    if (!ctx.hasMember(split.object, "replaceAll")) return ctx.report(node, `${message} (Needs lib ES2021.)`);
    const repText = rep ? ctx.text(rep) : ctx.quote(",");
    ctx.report(node, message, fix(tier, [ctx.replace(node, `${member(ctx, split.object)}.replaceAll(${ctx.text(sep)}, ${repText})`)], STRING));
  },
};

export const regexToStringMethod: RuleDef = {
  name: "regex-to-string-method",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`/^abc/.test(s)` → `s.startsWith('abc')` (also endsWith, includes, ===)",
  why: "Plain-text patterns don't need the regex engine. String methods skip regex compilation and matcher setup and are usually several times faster.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, "test");
    if (!m || m.args.length !== 1 || !ts.isRegularExpressionLiteral(m.object)) return;
    const { source, flags } = splitLiteral(m.object.text);
    if (/[^usd]/.test(flags)) return;
    const p = plainPattern(source);
    if (!p) return;
    const tier = ctx.isString(m.args[0]!) === "yes" ? "typed" : "assumed";
    const s = member(ctx, m.args[0]!);
    const lit = ctx.quote(p.value);
    let text: string;
    if (p.start && p.end) text = needsParens(node, 9) ? `(${ctx.text(m.args[0]!)} === ${lit})` : `${ctx.text(m.args[0]!)} === ${lit}`;
    else text = `${s}.${p.start ? "startsWith" : p.end ? "endsWith" : "includes"}(${lit})`;
    ctx.report(node, "This regex matches plain text; a string method is faster.", fix(tier, [ctx.replace(node, text)], "the argument is a string"));
  },
};

/** A regex usable as `re.test(...)` with the same result as match/search: a literal, or a const literal without g/y. */
function statelessRegex(expr: ts.Expression, ctx: RuleContext) {
  const e = unwrap(expr);
  if (ts.isRegularExpressionLiteral(e)) return e;
  if (!ts.isIdentifier(e)) return;
  const decl = ctx.checker.getSymbolAtLocation(e)?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !(decl.parent.flags & ts.NodeFlags.Const)) return;
  const init = decl.initializer && unwrap(decl.initializer);
  if (init && ts.isRegularExpressionLiteral(init) && !/[gy]/.test(splitLiteral(init.text).flags)) return e;
}

export const matchToTest: RuleDef = {
  name: "match-to-test",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`s.match(re)` / `re.exec(s)` used as a boolean → `re.test(s)`",
  why: "match and exec allocate a result array with captures; test only returns a boolean.",
  kinds: [K.CallExpression, K.BinaryExpression],
  check(node, ctx) {
    if (ts.isBinaryExpression(node)) return checkSearch(node, ctx);
    const m = methodCall(node, new Set(["match", "exec"]));
    if (!m || m.args.length !== 1 || !isBooleanContext(node)) return;
    if (m.name === "exec") {
      if (ctx.isType(m.object, "RegExp") !== "yes") return;
      const name = (m.call.expression as ts.PropertyAccessExpression).name;
      return ctx.report(node, "`.exec()` in a boolean context allocates a match array; use `.test()`.", fix("typed", [ctx.replace(name, "test")]));
    }
    const re = statelessRegex(m.args[0]!, ctx);
    const tier = byType(ctx.isString(m.object));
    if (!re || !tier) return;
    ctx.report(node, "`.match()` in a boolean context allocates a match array; use `re.test(s)`.",
      fix(tier, [ctx.replace(node, `${member(ctx, re)}.test(${ctx.text(m.object)})`)], STRING));
  },
};

function checkSearch(node: ts.BinaryExpression, ctx: RuleContext) {
  const m = methodCall(unwrap(node.left), "search");
  if (!m || m.args.length !== 1) return;
  const op = node.operatorToken.kind;
  const found = (op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken || op === K.GreaterThanToken) && isNumber(node.right, -1) ||
    op === K.GreaterThanEqualsToken && isNumber(node.right, 0);
  const missing = (op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken) && isNumber(node.right, -1) ||
    op === K.LessThanToken && isNumber(node.right, 0);
  const re = statelessRegex(m.args[0]!, ctx);
  const tier = byType(ctx.isString(m.object));
  if (!(found || missing) || !re || !tier) return;
  ctx.report(node, "`.search()` compared with -1 only tests for a match; use `re.test(s)`.",
    fix(tier, [ctx.replace(node, `${missing ? "!" : ""}${member(ctx, re)}.test(${ctx.text(m.object)})`)], STRING));
}

const EQ = new Set([K.EqualsEqualsEqualsToken, K.EqualsEqualsToken]);
const NE = new Set([K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken]);

export const indexOfToStartsWith: RuleDef = {
  name: "indexof-to-startswith",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`s.indexOf(x) === 0` → `s.startsWith(x)`",
  why: "When the prefix is missing, indexOf keeps scanning the whole string. startsWith compares only the prefix.",
  kinds: [K.BinaryExpression],
  check(node, ctx) {
    const n = node as ts.BinaryExpression;
    const op = n.operatorToken.kind;
    const [call, zero] = isNumber(n.right, 0) ? [n.left, n.right] : [n.right, n.left];
    const m = methodCall(unwrap(call), "indexOf");
    if (!m || m.args.length !== 1 || !isNumber(zero, 0) || !(EQ.has(op) || NE.has(op))) return;
    if (ctx.isString(m.object) !== "yes") return;
    const tier = ctx.isString(m.args[0]!) === "yes" ? "typed" : "assumed";
    const text = `${NE.has(op) ? "!" : ""}${member(ctx, m.object)}.startsWith(${ctx.text(m.args[0]!)})`;
    ctx.report(n, "`.indexOf(x) === 0` scans the whole string on a miss; use `.startsWith(x)`.",
      fix(tier, [ctx.replace(n, text)], "the argument is a string (`startsWith` throws on a RegExp)"));
  },
};

export const regexpConstructor: RuleDef = {
  name: "regexp-constructor-literal",
  impact: "low",
  tiers: ["exact"],
  description: "`new RegExp('a+b', 'g')` with constant arguments → `/a+b/g`",
  why: "A regex literal is parsed once and its compiled code is reused by the engine at that site. A constant RegExp constructor inside a function re-parses its source and looks up the cache on every call.",
  kinds: [K.NewExpression, K.CallExpression],
  check(node, ctx) {
    const n = node as ts.NewExpression | ts.CallExpression;
    if (!ts.isIdentifier(n.expression) || n.expression.text !== "RegExp") return;
    const args = n.arguments ?? [];
    if (!args.length || args.length > 2 || !args.every(isStringLit)) return;
    if (!insideFunction(n) && !repeatingAncestor(n)) return;
    const [src, flagArg] = args as (ts.StringLiteral | ts.NoSubstitutionTemplateLiteral)[];
    const flags = flagArg?.text ?? "";
    try {
      new RegExp(src!.text, flags);
    } catch {
      return;
    }
    const body = toLiteralBody(src!.text);
    if (body === undefined || new RegExp(body, flags).source !== new RegExp(src!.text, flags).source) return;
    const literal = `/${body}/${flags}`;
    ctx.report(n, "Constant `RegExp(...)` call; use a regex literal.", fix("exact", [ctx.replace(n, literal)]));
  },
};

export const catastrophicRegex: RuleDef = {
  name: "catastrophic-regex",
  impact: "high",
  tiers: [],
  description: "Nested quantifiers like `(a+)+` or `(\\w+\\s?)*`",
  why: "A repeated group whose body can match the same text several ways backtracks exponentially when the match fails (ReDoS). Make the inner part unambiguous, or use a possessive-style rewrite.",
  kinds: [K.RegularExpressionLiteral],
  check(node, ctx) {
    const { source } = splitLiteral((node as ts.RegularExpressionLiteral).text);
    if (hasNestedQuantifier(source)) {
      ctx.report(node, "Nested quantifiers can backtrack exponentially on non-matching input (ReDoS).");
    }
  },
};

export const stringRules = [
  splitJoin, regexToStringMethod, matchToTest, indexOfToStartsWith, regexpConstructor, catastrophicRegex,
];
