import ts from "typescript";
import {
  asMemberTarget, asStatements, boundNames, identifiersIn, isAssignedIn, isFunction, isLoop, isSimpleRef,
  methodCall, unwrap, walk,
} from "../../core/ast.ts";
import { byType, fix } from "../../core/fix.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const ITERATORS = new Set(["entries", "keys", "values", "matchAll"]);

interface Plan {
  returns: ts.ReturnStatement[];
}

/** Can the callback body run as a loop body? Returns the `return;` statements to turn into `continue;`. */
function planBody(fn: ts.ArrowFunction | ts.FunctionExpression): Plan | undefined {
  if (fn.asteriskToken || fn.modifiers?.some((m) => m.kind === K.AsyncKeyword)) return;
  if (fn.parameters.length > 2 || fn.typeParameters?.length) return;
  if (fn.parameters.some((p) => p.initializer || p.dotDotDotToken)) return;
  if (fn.parameters[1] && !ts.isIdentifier(fn.parameters[1].name)) return;
  const returns: ts.ReturnStatement[] = [];
  let ok = true;
  const arrowOnly = ts.isFunctionExpression(fn);
  walk(fn.body, (n) => {
    if (!ok) return false;
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return false;
    if (arrowOnly && (n.kind === K.ThisKeyword || (ts.isIdentifier(n) && n.text === "arguments"))) ok = false;
    if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped) &&
      !insideNestedFunction(n, fn)) ok = false;
    if (ts.isReturnStatement(n) && !insideNestedFunction(n, fn)) {
      if (n.expression || insideNestedLoop(n, fn)) ok = false;
      else returns.push(n);
    }
  }, false);
  return ok ? { returns } : undefined;
}

function insideNestedFunction(n: ts.Node, fn: ts.Node) {
  for (let p = n.parent; p && p !== fn; p = p.parent) if (ts.isFunctionLike(p)) return true;
  return false;
}

function insideNestedLoop(n: ts.Node, fn: ts.Node) {
  for (let p = n.parent; p && p !== fn; p = p.parent) if (isLoop(p)) return true;
  return false;
}

/** Loop body text: block contents with `return;` → `continue;`, or an expression body as a statement. */
function bodyText(fn: ts.ArrowFunction | ts.FunctionExpression, plan: Plan, ctx: RuleContext, indent: string) {
  const body = fn.body;
  if (!ts.isBlock(body)) {
    const inner = unwrap(body);
    const keepParens = ts.isObjectLiteralExpression(inner) || ts.isFunctionExpression(inner) || ts.isClassExpression(inner);
    return `\n${indent}  ${ctx.text(keepParens ? body : inner)};\n${indent}`;
  }
  const open = body.getStart(ctx.sf) + 1;
  let text = ctx.sf.text.slice(open, body.end - 1);
  for (const r of [...plan.returns].sort((a, b) => b.pos - a.pos)) {
    const s = r.getStart(ctx.sf) - open;
    text = `${text.slice(0, s)}continue;${text.slice(r.end - open)}`;
  }
  return text.includes("\n") ? text : `\n${indent}  ${text.trim()}\n${indent}`;
}

export const forEachToFor: RuleDef = {
  name: "foreach-to-for",
  impact: "medium",
  tiers: ["typed", "assumed"],
  description: "`xs.forEach(x => ...)` → indexed `for` loop",
  why: "An indexed loop has no per-element function call, so nothing has to be inlined. It is fastest in every engine tier, especially for large or polymorphic arrays. (Unlike forEach, it visits holes in sparse arrays.)",
  kinds: [K.ExpressionStatement],
  check(node, ctx) {
    const stmt = node as ts.ExpressionStatement;
    const m = methodCall(stmt.expression, "forEach");
    const fn = m?.args[0];
    if (!m || m.args.length !== 1 || !fn || !isFunction(fn)) return;
    const tier = byType(ctx.isArray(m.object));
    if (tier === "assumed" && methodCall(unwrap(m.object), ITERATORS)) return;
    const plan = planBody(fn);
    if (!tier || !plan) return;
    const [elem, idx] = fn.parameters;
    const names = [...(elem ? boundNames(elem.name) : []), ...(idx ? boundNames(idx.name) : [])];
    if (idx && isAssignedIn(fn.body, boundNames(idx.name))) return;
    const indent = ctx.indentOf(stmt);
    const recvIds = identifiersIn(m.object);
    const hoist = !isSimpleRef(m.object) || names.some((n) => recvIds.has(n));
    let pre = "";
    let arr = asMemberTarget(m.object, ctx.text(m.object));
    if (hoist) {
      const name = ctx.uniqueName("arr", stmt);
      pre = `const ${name} = ${ctx.text(m.object)};\n${indent}`;
      arr = name;
    }
    const i = idx ? (idx.name as ts.Identifier).text : ctx.uniqueName("i", stmt);
    const len = ctx.uniqueName("len", stmt);
    let decl = "";
    if (elem) {
      const kind = isAssignedIn(fn.body, boundNames(elem.name)) ? "let" : "const";
      const type = elem.type ? `: ${ctx.text(elem.type)}` : "";
      const bang = ctx.isTS && ctx.options.noUncheckedIndexedAccess ? "!" : "";
      decl = `\n${indent}  ${kind} ${ctx.text(elem.name)}${type} = ${arr}[${i}]${bang};`;
    }
    const loop = `${pre}for (let ${i} = 0, ${len} = ${arr}.length; ${i} < ${len}; ${i}++) {${decl}${bodyText(fn, plan, ctx, indent)}}`;
    ctx.report(m.call, "`.forEach()` calls a function per element; an indexed `for` loop avoids the call.",
      fix(tier, [ctx.replace(stmt, hoist ? asStatements(stmt, loop, indent) : loop)], "the receiver is an array without holes"));
  },
};
