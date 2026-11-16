import ts from "typescript";

export interface MethodCall {
  call: ts.CallExpression;
  object: ts.Expression;
  name: string;
  args: readonly ts.Expression[];
}

/** `obj.name(args)` without optional chaining; `names` restricts the method name. */
export function methodCall(node: ts.Node | undefined, names?: ReadonlySet<string> | string): MethodCall | undefined {
  if (!node || !ts.isCallExpression(node) || node.questionDotToken) return;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return;
  if (!ts.isIdentifier(callee.name)) return;
  const name = callee.name.text;
  if (typeof names === "string" ? name !== names : names && !names.has(name)) return;
  return { call: node, object: callee.expression, name, args: node.arguments };
}

/** `Global.name(args)`, e.g. `Math.max(...)`. */
export function staticCall(node: ts.Node | undefined, global: string, name: string) {
  const m = methodCall(node, name);
  return m && ts.isIdentifier(m.object) && m.object.text === global ? m : undefined;
}

export function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)
  ) expr = expr.expression;
  return expr;
}

export function isFunction(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function isLoop(node: ts.Node): node is ts.IterationStatement {
  return ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) ||
    ts.isWhileStatement(node) || ts.isDoStatement(node);
}

export const ITERATION_METHODS = new Set([
  "forEach", "map", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex",
  "findLast", "findLastIndex", "flatMap", "sort", "toSorted",
]);

/** Callback passed to an array iteration method, e.g. the arrow in `xs.map(x => ...)`. */
export function isIterationCallback(fn: ts.Node) {
  const m = isFunction(fn) ? methodCall(fn.parent, ITERATION_METHODS) : undefined;
  return !!m && m.args[0] === fn;
}

/** The loop or iteration callback that runs `node` repeatedly (loop initialisers and for-of heads run once). */
export function repeatingAncestor(node: ts.Node, callbacks = true): ts.Node | undefined {
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isFunctionLike(p)) {
      if (callbacks && isIterationCallback(p)) return p;
      return;
    }
    if (ts.isThrowStatement(p)) return;
    if (ts.isForStatement(p) && child !== p.initializer) return p;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && child === p.statement) return p;
    if (ts.isWhileStatement(p) || ts.isDoStatement(p)) return p;
    if (ts.isClassStaticBlockDeclaration(p) || ts.isSourceFile(p)) return;
  }
}

export function insideFunction(node: ts.Node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true;
  return false;
}

/** Visit descendants; `fn` returns false to skip a subtree. Non-arrow functions are skipped unless `intoFunctions`. */
export function walk(root: ts.Node, fn: (n: ts.Node) => boolean | void, intoFunctions = false) {
  const visit = (n: ts.Node): void => {
    if (fn(n) === false) return;
    if (!intoFunctions && ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(root, visit);
}

export function some(root: ts.Node, pred: (n: ts.Node) => boolean, intoFunctions = false) {
  let found = false;
  walk(root, (n) => {
    if (found) return false;
    if (pred(n)) found = true;
  }, intoFunctions);
  return found;
}

export function identifiersIn(node: ts.Node): Set<string> {
  const out = new Set<string>();
  if (ts.isIdentifier(node)) out.add(node.text);
  walk(node, (n) => { if (ts.isIdentifier(n)) out.add(n.text); }, true);
  return out;
}

export function boundNames(name: ts.BindingName, out: string[] = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
  return out;
}

/** Identifier, `this`, or a property chain of them: cheap and side-effect free to evaluate twice. */
export function isSimpleRef(expr: ts.Expression): boolean {
  expr = unwrap(expr);
  if (ts.isIdentifier(expr) || expr.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isPropertyAccessExpression(expr) && !expr.questionDotToken && isSimpleRef(expr.expression);
}

export function isAssignment(n: ts.Node): n is ts.BinaryExpression {
  return ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

export function isAssignedIn(root: ts.Node, names: readonly string[]) {
  const set = new Set(names);
  return some(root, (n) => {
    if (isAssignment(n)) {
      const left = unwrap(n.left);
      if (ts.isIdentifier(left)) return set.has(left.text);
      return (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) &&
        [...identifiersIn(left)].some((id) => set.has(id));
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      return ts.isIdentifier(n.operand) && set.has(n.operand.text);
    }
    return false;
  }, true);
}

/** if/while/for conditions, `!x`, ternary tests, and `&&`/`||` operands inside those. */
export function isBooleanContext(node: ts.Node): boolean {
  const p = node.parent;
  if (ts.isParenthesizedExpression(p)) return isBooleanContext(p);
  if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return p.expression === node;
  if (ts.isForStatement(p)) return p.condition === node;
  if (ts.isConditionalExpression(p)) return p.condition === node;
  if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return isBooleanContext(p);
    }
  }
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "Boolean") return true;
  return false;
}

const K = ts.SyntaxKind;
const PRECEDENCE = new Map<ts.SyntaxKind, number>([
  [K.QuestionQuestionToken, 3], [K.BarBarToken, 4], [K.AmpersandAmpersandToken, 5], [K.BarToken, 6],
  [K.CaretToken, 7], [K.AmpersandToken, 8],
  ...[K.EqualsEqualsToken, K.ExclamationEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken]
    .map((k) => [k, 9] as const),
  ...[K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken, K.InstanceOfKeyword, K.InKeyword]
    .map((k) => [k, 10] as const),
  ...[K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken].map((k) => [k, 11] as const),
  [K.PlusToken, 12], [K.MinusToken, 12], [K.AsteriskToken, 13], [K.SlashToken, 13], [K.PercentToken, 13],
  [K.AsteriskAsteriskToken, 14],
]);

/** Precedence of a binary operator token, for `needsParens`. */
export function precedence(op: ts.SyntaxKind) {
  return PRECEDENCE.get(op);
}

/** Whether an expression replacing `node` needs parentheses; `prec` is its top operator's precedence. */
export function needsParens(node: ts.Node, prec?: number): boolean {
  const p = node.parent;
  if (prec !== undefined && ts.isBinaryExpression(p)) {
    const parent = PRECEDENCE.get(p.operatorToken.kind);
    if (parent !== undefined) {
      const mixesNullish = (parent === 3) !== (prec === 3) && (parent <= 5 && prec <= 5);
      if (mixesNullish) return true;
      if (prec !== parent) return prec < parent;
      return parent === 14 ? p.left === node : p.right === node;
    }
  }
  return needsParensLoose(node);
}

function needsParensLoose(node: ts.Node): boolean {
  const p = node.parent;
  if (ts.isParenthesizedExpression(p) || ts.isExpressionStatement(p) || ts.isReturnStatement(p) ||
    ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isArrayLiteralExpression(p) ||
    ts.isTemplateSpan(p) || ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isSpreadElement(p) ||
    (ts.isConditionalExpression(p) && p.condition !== node)) return false;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return p.expression === node;
  if (ts.isElementAccessExpression(p)) return p.expression === node;
  if (ts.isArrowFunction(p)) return false;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    return op !== ts.SyntaxKind.CommaToken && !(op === ts.SyntaxKind.EqualsToken && p.right === node);
  }
  return true;
}

/** Text of `expr` safe to put before `.member`. */
export function asMemberTarget(expr: ts.Expression, text: string) {
  const e = expr;
  const primary = ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ||
    ts.isCallExpression(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isTemplateExpression(e) || ts.isArrayLiteralExpression(e) || e.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isRegularExpressionLiteral(e);
  return primary ? text : `(${text})`;
}

export function isNumber(node: ts.Node | undefined, value: number) {
  if (!node) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text) === value;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return ts.isNumericLiteral(node.operand) && -Number(node.operand.text) === value;
  }
  return false;
}

export function isStringLit(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

export function enclosingStatement(node: ts.Node): ts.Statement | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (n.parent && ts.isSourceFile(n.parent)) return n as ts.Statement;
  }
}

/** Replacement text for a statement list, wrapped in a block when the parent needs a single statement. */
export function asStatements(stmt: ts.Statement, text: string, indent: string) {
  const p = stmt.parent;
  const listParent = ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) ||
    ts.isDefaultClause(p) || ts.isModuleBlock(p);
  return listParent ? text : `{\n${indent}  ${text.replace(/\n/g, "\n  ")}\n${indent}}`;
}
