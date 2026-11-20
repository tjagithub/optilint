// React (and Preact) render costs: props and context values a render recreates, which defeat memoization, and keys
// that change every render. Report-only: the cost depends on what re-renders, which no benchmark here can measure.
import ts from "typescript";
import { isFunction, unwrap } from "../../core/ast.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
type Tag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/** Declared by React's types: `@types/react`, or an ambient `declare module "react"`. */
function fromReact(symbol: ts.Symbol | undefined) {
  return !!symbol?.declarations?.some((d) =>
    /[\\/]node_modules[\\/](@types[\\/])?react[\\/]/.test(d.getSourceFile().fileName) ||
    !!ts.findAncestor(d, (a) => ts.isModuleDeclaration(a) && ts.isStringLiteral(a.name) && a.name.text === "react"));
}

function declarationOf(expr: ts.Expression, ctx: RuleContext) {
  let symbol = ctx.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/** `name(...)` or `React.name(...)` (also Preact's). */
function isCallTo(expr: ts.Expression | undefined, names: ReadonlySet<string>) {
  const e = expr && unwrap(expr);
  if (!e || !ts.isCallExpression(e)) return false;
  const callee = e.expression;
  return (ts.isIdentifier(callee) && names.has(callee.text)) || (ts.isPropertyAccessExpression(callee) && names.has(callee.name.text));
}

function initializerOf(expr: ts.Expression, ctx: RuleContext) {
  const d = declarationOf(expr, ctx);
  return d && ts.isVariableDeclaration(d) ? d.initializer : undefined;
}

const MEMO = new Set(["memo"]);
const PURE = new Set(["PureComponent"]);

/** The component is `memo(...)` or a `PureComponent`: it skips a render when its props are shallowly equal. */
function isMemoized(tag: ts.JsxTagNameExpression, ctx: RuleContext) {
  if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return false;
  const type = ctx.checker.getTypeAtLocation(tag);
  if (type.getSymbol()?.getName() === "MemoExoticComponent" && fromReact(type.getSymbol())) return true;
  for (const sig of type.getConstructSignatures()) {
    for (let t: ts.Type | undefined = sig.getReturnType(); t; t = ctx.checker.getBaseTypes(t as ts.InterfaceType)[0]) {
      if (t.getSymbol()?.getName() === "PureComponent" && fromReact(t.getSymbol())) return true;
      if (!(t.flags & ts.TypeFlags.Object) || !((t as ts.ObjectType).objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Reference))) break;
    }
  }
  // Without React's types: a component declared in view, as `memo(...)` or `class extends PureComponent`.
  const d = declarationOf(tag as ts.Expression, ctx);
  if (d && ts.isVariableDeclaration(d)) return isCallTo(d.initializer, MEMO);
  return !!d && ts.isClassDeclaration(d) && !!d.heritageClauses?.some((h) => h.types.some((t) => {
    const e = t.expression;
    return (ts.isIdentifier(e) && PURE.has(e.text)) || (ts.isPropertyAccessExpression(e) && PURE.has(e.name.text));
  }));
}

const CONTEXT_TYPES = new Set(["Context", "ProviderExoticComponent"]);
const CREATE_CONTEXT = new Set(["createContext"]);

/** `<Ctx.Provider>`, or `<Ctx>` itself (React 19). */
function isContextProvider(tag: ts.JsxTagNameExpression, ctx: RuleContext) {
  const symbol = ctx.checker.getTypeAtLocation(tag).getSymbol();
  if (symbol && CONTEXT_TYPES.has(symbol.getName()) && fromReact(symbol)) return true;
  const context = ts.isPropertyAccessExpression(tag) ? (tag.name.text === "Provider" ? tag.expression : undefined) : tag;
  return !!context && ts.isIdentifier(context) && !/^[a-z]/.test(context.text) && isCallTo(initializerOf(context, ctx), CREATE_CONTEXT);
}

const HOOKS = new Set(["useMemo", "useCallback", "useRef", "useState", "useReducer"]);

/** What `expr` builds afresh each time the enclosing function runs, if anything. */
function fresh(expr: ts.Expression, ctx: RuleContext, follow = true): string | undefined {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return "object";
  if (ts.isArrayLiteralExpression(e)) return "array";
  if (isFunction(e)) return "function";
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return "element";
  if (ts.isNewExpression(e)) return "object";
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") return "function";
  if (!follow || !ts.isIdentifier(e)) return undefined;
  // A local declared in the same render: `const style = { ... }` or `function onClick() {}`.
  const d = declarationOf(e, ctx);
  if (!d || !ts.findAncestor(d.parent, ts.isFunctionLike)) return undefined;
  if (ts.isFunctionDeclaration(d)) return "function";
  if (!ts.isVariableDeclaration(d) || !d.initializer || !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return undefined;
  if (isCallTo(d.initializer, HOOKS)) return undefined;
  return fresh(d.initializer, ctx, false);
}

/** React Compiler memoizes this code: a `"use memo"` directive on it or its file, without a nearer `"use no memo"`. */
function compiled(node: ts.Node) {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    const body = ts.isSourceFile(p) ? p : ts.isFunctionLike(p) && "body" in p && p.body && ts.isBlock(p.body) ? p.body : undefined;
    for (const s of body?.statements ?? []) {
      if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) break;
      if (s.expression.text === "use memo") return true;
      if (s.expression.text === "use no memo") return false;
    }
  }
  return false;
}

const attributes = (el: Tag) => el.attributes.properties.filter(ts.isJsxAttribute);
const valueOf = (a: ts.JsxAttribute) => a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
const nameOf = (a: ts.JsxAttribute) => a.name.getText();
const list = (names: string[]) => names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const SKIPPED_PROPS = new Set(["key", "ref"]);
const COMPILER = ["babel-plugin-react-compiler", "react-compiler-runtime"];

export const inlinePropToMemo: RuleDef = {
  name: "inline-prop-to-memo",
  impact: "medium",
  tiers: [],
  redundantWith: COMPILER,
  description: "A `memo` or `PureComponent` component given an object, array, function or element made during render",
  why: "`memo` and `PureComponent` skip a render only when every prop is the same as last time (`Object.is`). An inline `{}`, `[]`, arrow or JSX element is a new value on every render, so the component re-renders every time and also pays for the comparison. Hoist constants out of the component, and wrap the rest in `useMemo` or `useCallback`. With React Compiler, this is done for you.",
  kinds: [K.JsxOpeningElement, K.JsxSelfClosingElement],
  check(node, ctx) {
    const el = node as Tag;
    if (!ts.findAncestor(el, ts.isFunctionLike) || compiled(el) || !isMemoized(el.tagName, ctx)) return;
    const hits = attributes(el).filter((a) => !SKIPPED_PROPS.has(nameOf(a)) && valueOf(a) && fresh(valueOf(a)!, ctx));
    const children = ts.isJsxOpeningElement(el) && el.parent.children.some((c) => !ts.isJsxText(c) || !c.containsOnlyTriviaWhiteSpaces);
    if (!hits.length && !children) return;
    const names = hits.map((a) => `\`${nameOf(a)}\``);
    if (children) names.push("its children");
    ctx.report(hits[0] ?? el, `\`${ctx.text(el.tagName)}\` is memoized, but ${list(names)} ${names.length > 1 || !hits.length ? "are" : "is"} new on every render, so it re-renders anyway; hoist them, or wrap them in \`useMemo\`/\`useCallback\`.`);
  },
};

export const inlineContextValue: RuleDef = {
  name: "inline-context-value",
  impact: "medium",
  tiers: [],
  redundantWith: COMPILER,
  description: "A context provider whose `value` is an object, array or function made during render",
  why: "Every component that reads a context re-renders when its `value` changes (`Object.is`), however deep it is and even inside `memo`. A `value={{ user, setUser }}` built in render is new each time, so every consumer re-renders whenever the provider does. Wrap the value in `useMemo` (and its functions in `useCallback`), or hoist it. With React Compiler, this is done for you.",
  kinds: [K.JsxOpeningElement, K.JsxSelfClosingElement],
  check(node, ctx) {
    const el = node as Tag;
    const value = attributes(el).find((a) => nameOf(a) === "value");
    const expr = value && valueOf(value);
    const kind = expr && fresh(expr, ctx);
    if (!kind || !ts.findAncestor(el, ts.isFunctionLike) || compiled(el) || !isContextProvider(el.tagName, ctx)) return;
    ctx.report(value, `This context value is a new ${kind} on every render, so every consumer of \`${ctx.text(el.tagName)}\` re-renders with it; wrap it in \`useMemo\` or hoist it.`);
  },
};

const RANDOM_CALLS = new Set(["Math.random", "Date.now", "performance.now", "crypto.randomUUID", "nanoid", "uuid", "uuidv4", "v4", "cuid", "createId", "uniqueId"]);

/** A call in `expr` (not inside a function) whose result differs on every call. */
function randomCall(expr: ts.Node): ts.Node | undefined {
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? `${ts.isIdentifier(callee.expression) ? callee.expression.text : ""}.${callee.name.text}` : "";
    if (RANDOM_CALLS.has(name) || name.endsWith(".randomUUID")) return expr;
  }
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Date") return expr;
  if (ts.isFunctionLike(expr)) return undefined;
  return ts.forEachChild(expr, randomCall);
}

export const unstableKey: RuleDef = {
  name: "unstable-key",
  impact: "high",
  tiers: [],
  description: "A JSX `key` from `Math.random()`, `crypto.randomUUID()`, `Date.now()` or a fresh id",
  why: "React matches elements across renders by `key`. A key that changes on every render makes React unmount the old element and mount a new one each time: its whole subtree is rebuilt, its DOM replaced, and its state and effects reset. Key by a stable id from the data, or generate ids once, when the data is created.",
  kinds: [K.JsxAttribute],
  check(node, ctx) {
    const a = node as ts.JsxAttribute;
    const expr = nameOf(a) === "key" ? valueOf(a) : undefined;
    const call = expr && randomCall(expr);
    if (!call) return;
    ctx.report(a, `This key comes from \`${ctx.text(call)}\`, which changes on every render, so the element is unmounted and remounted each time; key by a stable id from the data.`);
  },
};

export const reactRules: readonly RuleDef[] = [inlinePropToMemo, inlineContextValue, unstableKey];
