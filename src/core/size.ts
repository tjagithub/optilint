import ts from "typescript";
import { isFunction, methodCall, repeatingAncestor, staticCall, unwrap } from "./ast.ts";
import type { RuleContext } from "./types.ts";

const GROW = new Set(["push", "unshift", "splice"]);

/** Whether `file` may add elements to the array named `name`. */
function grown(name: string, file: ts.SourceFile) {
  const visit = (n: ts.Node): boolean => {
    const m = methodCall(n, GROW);
    if (m && ts.isIdentifier(m.object) && m.object.text === name) return true;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(n.left);
      const target = ts.isElementAccessExpression(left) || ts.isPropertyAccessExpression(left) ? unwrap(left.expression) : undefined;
      if (target && ts.isIdentifier(target) && target.text === name) return true;
    }
    return !!ts.forEachChild(n, (c) => visit(c) || undefined);
  };
  return visit(file);
}

/** The `const` declaration `id` names, following imports. */
function constDecl(id: ts.Identifier, ctx: RuleContext) {
  let sym = ctx.checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = ctx.checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  return decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? decl : undefined;
}

/** `Object.keys(O)` (or `values`, `entries`) of a never-changed `const` object literal with at most `max` properties. */
function smallObjectKeys(init: ts.Expression, ctx: RuleContext, max: number) {
  const call = staticCall(init, "Object", "keys") ?? staticCall(init, "Object", "values") ?? staticCall(init, "Object", "entries");
  const arg = call?.args.length === 1 ? unwrap(call.args[0]!) : undefined;
  const decl = arg && ts.isIdentifier(arg) ? constDecl(arg, ctx) : undefined;
  const obj = decl && unwrap(decl.initializer!);
  return !!obj && ts.isObjectLiteralExpression(obj) && obj.properties.length <= max &&
    !obj.properties.some(ts.isSpreadAssignment) && !grown((arg as ts.Identifier).text, decl.getSourceFile());
}

/** At most `max` elements: a literal, a tuple, a rest parameter, or a never-grown `const` literal or
 * `Object.keys` of a small `const` object literal. */
export function knownSmall(expr: ts.Expression, ctx: RuleContext, max: number): boolean {
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e)) return e.elements.length <= max && !e.elements.some(ts.isSpreadElement);
  const type = ctx.checker.getTypeAtLocation(e);
  if (ctx.checker.isTupleType(type)) {
    const tuple = (type as ts.TypeReference).target as ts.TupleType;
    if (!tuple.hasRestElement && tuple.fixedLength <= max) return true;
  }
  if (!ts.isIdentifier(e)) return false;
  const param = ctx.checker.getSymbolAtLocation(e)?.valueDeclaration;
  if (param && ts.isParameter(param) && param.dotDotDotToken) return true;
  const decl = constDecl(e, ctx);
  if (!decl) return false;
  const init = unwrap(decl.initializer!);
  if (grown(decl.name.getText(), decl.getSourceFile())) return false;
  return ts.isArrayLiteralExpression(init) ? knownSmall(init, ctx, max) : smallObjectKeys(init, ctx, max);
}

/** What a loop or iteration callback walks: `for (x of xs)`, `xs.map(cb)`. */
function iterated(loop: ts.Node): ts.Expression | undefined {
  if (ts.isForOfStatement(loop)) return loop.expression;
  const call = loop.parent;
  if (isFunction(loop) && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return call.expression.expression;
  return undefined;
}

/** Every repeat from `loop` outward walks a collection of at most `max` items, so its body runs a few times. */
export function fewIterations(loop: ts.Node, ctx: RuleContext, max: number) {
  for (let l: ts.Node | undefined = loop; l; l = repeatingAncestor(l)) {
    const xs = iterated(l);
    if (!xs || !knownSmall(xs, ctx, max)) return false;
  }
  return true;
}
