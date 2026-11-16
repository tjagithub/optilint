import ts from "typescript";
import { boundNames, identifiersIn, isAssignment, isFunction, isLoop, methodCall, repeatingAncestor, staticCall, unwrap } from "../../core/ast.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const ORDER = "if order matters, disable this line";
// Awaiting one of these paces the loop on purpose.
const TIMERS = new Set(["setTimeout", "sleep", "delay", "wait", "waitForTimeout", "timeout"]);
const BATCH = new Set(["all", "allSettled", "race", "any"]);
// Calls declared here drive one stateful target (a page, an editor, a terminal), so their order matters.
const ORDERED_PATH = /\/node_modules\/(?:@types\/)?(?:playwright-core|playwright|puppeteer|puppeteer-core|webdriverio|selenium-webdriver|vscode)\//;
const ORDERED_MODULE = /^(?:node:)?(?:vscode|readline(?:\/promises)?|stream(?:\/promises)?)$/;

/** `pred` on `root` or a descendant, without entering nested functions. */
function contains(root: ts.Node, pred: (n: ts.Node) => boolean): boolean {
  return pred(root) || (!ts.isFunctionLike(root) && !!ts.forEachChild(root, (c) => contains(c, pred) || undefined));
}

function calleeName(e: ts.Expression) {
  const callee = ts.isCallExpression(e) ? e.expression : undefined;
  if (callee && ts.isIdentifier(callee)) return callee.text;
  return callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function isTimer(e: ts.Expression) {
  if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === "Promise" && identifiersIn(e).has("setTimeout");
  return TIMERS.has(calleeName(e) ?? "");
}

function drivesOrderedTarget(e: ts.Expression, ctx: RuleContext) {
  if (!ts.isCallExpression(e)) return false;
  const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
  let sym = ctx.checker.getSymbolAtLocation(callee);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = ctx.checker.getAliasedSymbol(sym);
  return !!sym?.declarations?.some((d) => ORDERED_PATH.test(d.getSourceFile().fileName) ||
    !!ts.findAncestor(d, (a) => ts.isModuleDeclaration(a) && ts.isStringLiteral(a.name) && ORDERED_MODULE.test(a.name.text)));
}

function functionName(node: ts.Node) {
  const fn = ts.findAncestor(node.parent, ts.isFunctionLike);
  if (fn && "name" in fn && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const decl = fn?.parent;
  return decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
}

/** Whether `b` leaves `loop`, rather than an inner loop or switch. */
function breaksOut(b: ts.BreakStatement, loop: ts.IterationStatement) {
  if (b.label) return ts.isLabeledStatement(loop.parent) && loop.parent.label.text === b.label.text;
  for (let p = b.parent; p !== loop; p = p.parent) if (isLoop(p) || ts.isSwitchStatement(p)) return false;
  return true;
}

function isExit(n: ts.Node, loop: ts.IterationStatement) {
  if (ts.isReturnStatement(n)) return true;
  if (ts.isBreakStatement(n)) return breaksOut(n, loop);
  const m = methodCall(n, "exit");
  return !!m && ts.isIdentifier(m.object) && m.object.text === "process";
}

/** Names the loop assigns from an `await`: the next iteration sees them. */
function awaitAssigned(loop: ts.IterationStatement) {
  const out = new Set<string>();
  contains(loop.statement, (n) => {
    if (!isAssignment(n) || !contains(n.right, ts.isAwaitExpression)) return false;
    const left = unwrap(n.left);
    if (ts.isIdentifier(left)) out.add(left.text);
    else if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) for (const id of identifiersIn(left)) out.add(id);
    return false;
  });
  return out;
}

function condition(loop: ts.IterationStatement) {
  if (ts.isForStatement(loop)) return loop.condition;
  return ts.isWhileStatement(loop) || ts.isDoStatement(loop) ? loop.expression : undefined;
}

/** Why the loop must stay sequential, if a reason can be seen. */
function sequentialByDesign(loop: ts.IterationStatement, awaits: ts.AwaitExpression[], ctx: RuleContext) {
  const cond = condition(loop);
  // Polls or retries: it runs until an awaited value says stop.
  if ((ts.isForStatement(loop) || ts.isWhileStatement(loop) || ts.isDoStatement(loop)) && (!cond || cond.kind === K.TrueKeyword)) return true;
  const carried = awaitAssigned(loop);
  if (cond && contains(cond, (n) => ts.isAwaitExpression(n) || (ts.isIdentifier(n) && carried.has(n.text)))) return true;
  const self = functionName(loop);
  return awaits.some((a) => {
    const e = unwrap(a.expression);
    const batch = methodCall(e, BATCH);
    return isTimer(e) || (!!batch && ts.isIdentifier(batch.object) && batch.object.text === "Promise") ||
      (self !== undefined && calleeName(e) === self) || drivesOrderedTarget(e, ctx) ||
      [...identifiersIn(e)].some((id) => carried.has(id));
  }) || contains(loop.statement, (n) => n.pos > awaits[0]!.pos && isExit(n, loop));
}

/** `await p` on the loop variable, or `await ps[i]`: the work already started before the loop. */
function alreadyRunning(a: ts.AwaitExpression, loopVars: Set<string>) {
  const e = unwrap(a.expression);
  return ts.isElementAccessExpression(e) || (ts.isIdentifier(e) && loopVars.has(e.text));
}

function checkLoop(loop: ts.IterationStatement, ctx: RuleContext) {
  if (ts.isForOfStatement(loop) && loop.awaitModifier) return;
  const awaits: ts.AwaitExpression[] = [];
  contains(loop, (n) => {
    if (n !== loop && ts.isAwaitExpression(n) && repeatingAncestor(n, false) === loop) awaits.push(n);
    return false;
  });
  const init = (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && ts.isVariableDeclarationList(loop.initializer)
    ? loop.initializer.declarations.flatMap((d) => boundNames(d.name)) : [];
  const first = awaits.find((a) => !alreadyRunning(a, new Set(init)));
  if (!first || sequentialByDesign(loop, awaits, ctx)) return;
  ctx.report(first, `Sequential \`await\` in a loop; run independent iterations concurrently with \`Promise.all\` (${ORDER}).`);
}

/** `xs.reduce(async (acc, x) => { await acc; ... }, Promise.resolve())`, or with `acc.then(...)`. */
function checkReduce(call: ts.CallExpression, ctx: RuleContext) {
  const m = methodCall(call, "reduce") ?? methodCall(call, "reduceRight");
  const [cb, init] = m?.args.length === 2 ? m.args.map(unwrap) : [];
  if (!cb || !init || !isFunction(cb)) return;
  const acc = cb.parameters[0]?.name;
  if (!acc || !ts.isIdentifier(acc)) return;
  if (!staticCall(init, "Promise", "resolve") && ctx.isType(init, "Promise") !== "yes") return;
  const isAcc = (e: ts.Expression) => ts.isIdentifier(unwrap(e)) && (unwrap(e) as ts.Identifier).text === acc.text;
  const chains = contains(cb.body, (n) => (ts.isAwaitExpression(n) && isAcc(n.expression)) || (methodCall(n, "then") !== undefined && isAcc(methodCall(n, "then")!.object)));
  if (chains) ctx.report(call, `\`${m!.name}\` chains the promises, so each call waits for the previous one; use \`Promise.all\` if they are independent (${ORDER}).`);
}

export const awaitInLoop: RuleDef = {
  name: "await-in-loop",
  impact: "high",
  tiers: [],
  description: "`await` inside a loop body, or a promise chain built with `reduce`",
  why: "Each iteration waits for the previous one, so total time is the sum of all latencies. If iterations are independent, start them all and `await Promise.all(...)` (or batch them to bound concurrency). Loops that poll, retry, pace themselves, stop early, carry a value to the next iteration, or drive one browser page, editor or terminal are left alone.",
  kinds: [K.ForStatement, K.ForOfStatement, K.ForInStatement, K.WhileStatement, K.DoStatement, K.CallExpression],
  check(node, ctx) {
    if (ts.isCallExpression(node)) checkReduce(node, ctx);
    else checkLoop(node as ts.IterationStatement, ctx);
  },
};
