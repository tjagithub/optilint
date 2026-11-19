import ts from "typescript";
import { isDense, isFunction, walk } from "./ast.ts";
import type { RuleContext } from "./types.ts";

const K = ts.SyntaxKind;

/** Array methods that never write to the array. A callback could still get it as its third argument. */
const READS = new Set([
  "at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap",
  "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some",
  "toLocaleString", "toReversed", "toSorted", "toSpliced", "toString", "values", "with",
]);

/** Is `node` written to: assigned, destructured into, incremented, deleted or a for-in/of target? */
function isWritten(node: ts.Expression): boolean {
  let n: ts.Node = node;
  while (ts.isParenthesizedExpression(n.parent) || ts.isArrayLiteralExpression(n.parent) || ts.isSpreadElement(n.parent) ||
    ts.isPropertyAssignment(n.parent) || ts.isObjectLiteralExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (ts.isBinaryExpression(p)) return p.left === n && p.operatorToken.kind >= K.FirstAssignment && p.operatorToken.kind <= K.LastAssignment;
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) return p.operator === K.PlusPlusToken || p.operator === K.MinusMinusToken;
  if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
  return ts.isDeleteExpression(p);
}

/** An argument that cannot get the array: not callable, or an inline function with under three parameters. */
const cannotGetArray = (arg: ts.Expression, ctx: RuleContext) =>
  isFunction(arg) ? arg.parameters.length < 3 && !arg.parameters.some((p) => p.dotDotDotToken)
    : !ctx.checker.getTypeAtLocation(arg).getCallSignatures().length;

/** Does this use of an array variable only read it (`xs[i]`, `xs.length`, `xs.map(f)`, `for (x of xs)`, `...xs`)? */
function onlyReads(ref: ts.Identifier, ctx: RuleContext): boolean {
  const p = ref.parent;
  if ((ts.isForOfStatement(p) && p.expression === ref) || ts.isSpreadElement(p)) return true;
  if (ts.isElementAccessExpression(p) && p.expression === ref) return !isWritten(p);
  if (!ts.isPropertyAccessExpression(p) || p.expression !== ref) return false;
  if (p.name.text === "length") return !isWritten(p);
  const call = p.parent;
  return READS.has(p.name.text) && ts.isCallExpression(call) && call.expression === p &&
    call.arguments.every((a) => cannotGetArray(a, ctx));
}

/** A `const` array that has no holes and never gets any: built without them, private to this module, and only
 * read wherever it is used. */
export function denseConst(id: ts.Identifier, ctx: RuleContext): boolean {
  const sym = ctx.checker.getSymbolAtLocation(id);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return false;
  if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) || !isDense(decl.initializer)) return false;
  // Another module or script could reach it and write to it.
  if (decl.getSourceFile() !== ctx.sf || !ts.isExternalModule(ctx.sf)) return false;
  const stmt = decl.parent.parent;
  if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === K.ExportKeyword)) return false;
  let ok = true;
  walk(ctx.sf, (n) => {
    if (!ok) return false;
    if (!ts.isIdentifier(n) || n === decl.name || n.text !== id.text) return;
    if (ts.isExportSpecifier(n.parent)) ok = false;
    else if (ctx.checker.getSymbolAtLocation(n) === sym) ok = onlyReads(n, ctx);
  }, true);
  return ok;
}
