import ts from "typescript";
import { asMemberTarget, boundNames, identifiersIn, isAssignedIn, isSimpleRef, methodCall, some, unwrap } from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

function loopDecl(init: ts.ForInitializer) {
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return;
  if (!(init.flags & ts.NodeFlags.BlockScoped)) return;
  return { decl: init.declarations[0]!, kind: init.flags & ts.NodeFlags.Const ? "const" : "let" };
}

/** Prepend `prefix` to a loop body, turning a single statement into a block. */
function withPrefix(body: ts.Statement, prefix: string, ctx: RuleContext, indent: string) {
  if (ts.isBlock(body)) {
    const open = body.getStart(ctx.sf) + 1;
    return `{\n${indent}  ${prefix}${ctx.sf.text.slice(open, body.end)}`;
  }
  return `{\n${indent}  ${prefix}\n${indent}  ${ctx.text(body)}\n${indent}}`;
}

/** Name for the receiver, hoisting it when it is not a cheap reference or the loop variable shadows it. */
function receiver(expr: ts.Expression, names: string[], ctx: RuleContext, indent: string) {
  const ids = identifiersIn(expr);
  if (isSimpleRef(expr) && !names.some((n) => ids.has(n))) {
    return { pre: "", arr: asMemberTarget(expr, ctx.text(expr)) };
  }
  const arr = ctx.uniqueName("arr", expr);
  return { pre: `const ${arr} = ${ctx.text(expr)};\n${indent}`, arr };
}

function blockSafe(stmt: ts.Statement) {
  const p = stmt.parent;
  return ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isModuleBlock(p);
}

export const forOfToIndexed: RuleDef = {
  name: "for-of-to-indexed",
  impact: "low",
  tiers: ["typed"],
  // Modern engines run for-of over arrays nearly as fast; the rewrite is mostly churn.
  recommended: false,
  description: "`for (const x of xs)` → indexed `for` loop (proven arrays only)",
  why: "for-of runs the iterator protocol. Optimizing compilers can remove that cost, but baseline tiers and cold code still pay it on every step, and an indexed loop never does.",
  kinds: [K.ForOfStatement],
  check(node, ctx) {
    const n = node as ts.ForOfStatement;
    const d = loopDecl(n.initializer);
    if (n.awaitModifier || !d || d.decl.initializer) return;
    // Unknown types are usually Maps, Sets or generators here, so only proven arrays qualify.
    if (ctx.isArray(n.expression) !== "yes") return;
    const names = boundNames(d.decl.name);
    const indent = ctx.indentOf(n);
    const { pre, arr } = receiver(n.expression, names, ctx, indent);
    const message = "for-of over an array uses the iterator protocol; an indexed loop is cheaper in every tier.";
    if (pre && !blockSafe(n)) return ctx.report(n, message);
    const i = ctx.uniqueName("i", n);
    const type = d.decl.type ? `: ${ctx.text(d.decl.type)}` : "";
    const bang = ctx.isTS && ctx.options.noUncheckedIndexedAccess ? "!" : "";
    const prefix = `${d.kind} ${ctx.text(d.decl.name)}${type} = ${arr}[${i}]${bang};`;
    const text = `${pre}for (let ${i} = 0; ${i} < ${arr}.length; ${i}++) ${withPrefix(n.statement, prefix, ctx, indent)}`;
    ctx.report(n, message, fix("typed", [ctx.replace(n, text)]));
  },
};

export const forInArray: RuleDef = {
  name: "for-in-array",
  impact: "high",
  tiers: ["assumed"],
  description: "`for (const k in array)` → indexed loop",
  why: "for-in enumerates string keys, including inherited ones, through a slow generic path. Indices come back as strings, so every `xs[k]` also converts the key. Note: the fix makes the index a number.",
  kinds: [K.ForInStatement],
  check(node, ctx) {
    const n = node as ts.ForInStatement;
    if (ctx.isArray(n.expression) !== "yes") return;
    const d = loopDecl(n.initializer);
    const rewrite = d && ts.isIdentifier(d.decl.name) && isSimpleRef(n.expression) &&
      !identifiersIn(n.expression).has(d.decl.name.text) && !isAssignedIn(n.statement, [d.decl.name.text])
      ? (() => {
        const k = (d.decl.name as ts.Identifier).text;
        const arr = asMemberTarget(n.expression, ctx.text(n.expression));
        const head = `for (let ${k} = 0; ${k} < ${arr}.length; ${k}++) `;
        return fix("assumed", [ctx.replace(n, head + ctx.text(n.statement))], "the array has no holes or extra properties, and the body does not need string keys");
      })()
      : undefined;
    ctx.report(n, "for-in over an array enumerates string keys slowly; use an indexed loop.", rewrite);
  },
};

const READ_ONLY = new Set([
  "at", "includes", "indexOf", "lastIndexOf", "join", "slice", "map", "filter", "some", "every", "find",
  "findIndex", "reduce", "forEach", "concat", "toSorted", "toReversed", "with", "flatMap", "flat",
]);

/** Every use of `name` in `body` leaves its length alone: element reads/writes at the index, `.length`, read-only methods. */
function lengthStable(body: ts.Node, name: string, index: string) {
  return !some(body, (n) => {
    if (!ts.isIdentifier(n) || n.text !== name) return false;
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === n) {
      if (p.name.text === "length") return isWriteTarget(p);
      return !(methodCall(p.parent) && READ_ONLY.has(p.name.text));
    }
    if (ts.isElementAccessExpression(p) && p.expression === n) {
      const arg = unwrap(p.argumentExpression);
      return isWriteTarget(p) && !(ts.isIdentifier(arg) && arg.text === index);
    }
    return true;
  }, true);
}

function isWriteTarget(n: ts.Node) {
  const p = n.parent;
  return (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= K.FirstAssignment &&
    p.operatorToken.kind <= K.LastAssignment) || ts.isDeleteExpression(p);
}

export const cacheLength: RuleDef = {
  name: "cache-array-length",
  impact: "low",
  tiers: ["typed", "assumed"],
  description: "`for (let i = 0; i < xs.length; i++)` → cache `xs.length`",
  why: "Reading `.length` in the condition is a load per iteration, and engines can only hoist it when they can prove the body leaves the array alone. Caching it makes that explicit.",
  kinds: [K.ForStatement],
  check(node, ctx) {
    const n = node as ts.ForStatement;
    const cond = n.condition && unwrap(n.condition);
    if (!cond || !ts.isBinaryExpression(cond) || cond.operatorToken.kind !== K.LessThanToken) return;
    const len = unwrap(cond.right);
    if (!ts.isPropertyAccessExpression(len) || len.name.text !== "length" || !ts.isIdentifier(len.expression)) return;
    if (!n.initializer || !ts.isVariableDeclarationList(n.initializer) || !ts.isIdentifier(cond.left)) return;
    if (n.initializer.flags & ts.NodeFlags.Const) return;
    const arr = len.expression.text;
    const index = cond.left.text;
    // A string's length cannot change, so engines already hoist it; only arrays gain.
    if (ctx.isArray(len.expression) !== "yes") return;
    const stable = lengthStable(n.statement, arr, index) && !(n.incrementor && some(n.incrementor, (x) => ts.isIdentifier(x) && x.text === arr, true));
    if (!stable) return;
    const callsOut = some(n.statement, (x) => ts.isCallExpression(x) && !methodCall(x, READ_ONLY), true);
    const name = ctx.uniqueName("len", n);
    const last = n.initializer.declarations.at(-1)!;
    ctx.report(len, `\`${arr}.length\` is re-read on every iteration; cache it in the loop header.`, fix(
      callsOut ? "assumed" : "typed",
      [{ start: last.end, end: last.end, text: `, ${name} = ${arr}.length` }, ctx.replace(len, name)],
      `the functions called in the loop do not change \`${arr}.length\``,
    ));
  },
};

export const indexedRules = [forOfToIndexed, forInArray, cacheLength];
