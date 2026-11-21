import ts from "typescript";

/** Whether `d` comes from one of `packages`: a file in node_modules/<pkg> or node_modules/@types/<pkg>, or an ambient
 * `declare module "<pkg>"` (also as "node:<pkg>"), as @types/node declares its modules. */
export function declaredIn(d: ts.Declaration, packages: readonly string[]): boolean {
  const file = d.getSourceFile().fileName.replaceAll("\\", "/");
  if (packages.some((p) => file.includes(`/node_modules/${p}/`) || file.includes(`/node_modules/@types/${p}/`))) return true;
  return !!ts.findAncestor(d, (a) => ts.isModuleDeclaration(a) && ts.isStringLiteral(a.name) && packages.includes(a.name.text.replace(/^node:/, "")));
}

/** The declarations of what `expr` names (`f` or `x.f`), through imports and re-exports. */
export function declarationsOf(expr: ts.Expression, checker: ts.TypeChecker): readonly ts.Declaration[] {
  let s = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  return s?.declarations ?? [];
}
