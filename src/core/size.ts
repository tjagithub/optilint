import ts from "typescript";
import { methodCall, unwrap } from "./ast.ts";
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

/** At most `max` elements: a literal, a tuple, a never-grown `const` literal, or a rest parameter. */
export function knownSmall(expr: ts.Expression, ctx: RuleContext, max: number): boolean {
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e)) return e.elements.length <= max && !e.elements.some(ts.isSpreadElement);
  const type = ctx.checker.getTypeAtLocation(e);
  if (ctx.checker.isTupleType(type)) {
    const tuple = (type as ts.TypeReference).target as ts.TupleType;
    if (!tuple.hasRestElement && tuple.fixedLength <= max) return true;
  }
  if (!ts.isIdentifier(e)) return false;
  const decl = ctx.checker.getSymbolAtLocation(e)?.valueDeclaration;
  if (decl && ts.isParameter(decl) && decl.dotDotDotToken) return true;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return false;
  const init = unwrap(decl.initializer);
  return ts.isArrayLiteralExpression(init) && knownSmall(init, ctx, max) && !grown(e.text, decl.getSourceFile());
}
