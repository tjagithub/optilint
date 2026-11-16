import ts from "typescript";
import { isBooleanContext, isNumber, isSimpleRef, isStringLit, staticCall, unwrap } from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import type { RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

export const objectAssignToSpread: RuleDef = {
  name: "object-assign-to-spread",
  impact: "medium",
  tiers: ["typed"],
  description: "`Object.assign({}, a, b)` → `{ ...a, ...b }`",
  why: "Object spread into a fresh literal uses the engine's clone fast path (CloneObjectIC in V8). Object.assign goes through the generic [[Set]] path, one property at a time.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = staticCall(node, "Object", "assign");
    const target = m?.args[0] && unwrap(m.args[0]);
    if (!m || m.args.length < 2 || !target || !ts.isObjectLiteralExpression(target)) return;
    if (m.args.some((a) => ts.isSpreadElement(a))) return;
    if (target.properties.some((p) => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))) return;
    const parts = [
      ...target.properties.map((p) => ctx.text(p)),
      ...m.args.slice(1).map((a) => `...${ctx.text(a)}`),
    ];
    const literal = `{ ${parts.join(", ")} }`;
    const p = node.parent;
    const wrap = ts.isExpressionStatement(p) || (ts.isArrowFunction(p) && p.body === node);
    ctx.report(node, "`Object.assign({}, ...)` is slower than object spread.", fix("typed", [ctx.replace(node, wrap ? `(${literal})` : literal)]));
  },
};

/** `for (const [k, v] of Object.entries(o))` with at most two plain bindings, split into its parts. */
function entriesLoop(node: ts.Node) {
  const n = node as ts.ForOfStatement;
  const m = staticCall(unwrap(n.expression), "Object", "entries");
  const init = n.initializer;
  if (!m || m.args.length !== 1 || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return;
  const pattern = init.declarations[0]!.name;
  if (!ts.isArrayBindingPattern(pattern) || pattern.elements.length > 2) return;
  const [k, v] = pattern.elements;
  const name = (el?: ts.ArrayBindingElement) =>
    el && ts.isBindingElement(el) && !el.initializer && !el.dotDotDotToken ? el.name : undefined;
  const keyName = name(k);
  const valName = name(v);
  // Only the key, or only the value: object-entries-iteration. Anything else: object-entries-pair.
  const single = (!keyName && valName) || (keyName && !v);
  return { n, init, obj: m.args[0]!, kind: init.flags & ts.NodeFlags.Const ? "const" : "let", keyName, valName, single };
}

const ENTRIES = "`Object.entries()` allocates an array per property.";

export const objectEntries: RuleDef = {
  name: "object-entries-iteration",
  impact: "medium",
  tiers: ["exact"],
  description: "`for (const [k] / [, v] of Object.entries(o))` → `Object.keys` / `Object.values`",
  why: "Object.entries allocates a [key, value] array per property. A loop that uses only the keys or only the values gets them from Object.keys or Object.values without the pairs.",
  kinds: [K.ForOfStatement],
  check(node, ctx) {
    const l = entriesLoop(node);
    if (!l?.single) return;
    const [binding, call] = l.valName && !l.keyName ? [l.valName, "values"] : [l.keyName!, "keys"];
    ctx.report(l.n.expression, ENTRIES,
      fix("exact", [ctx.replace(l.init, `${l.kind} ${ctx.text(binding)}`), ctx.replace(l.n.expression, `Object.${call}(${ctx.text(l.obj)})`)]));
  },
};

export const objectEntriesPair: RuleDef = {
  name: "object-entries-pair",
  impact: "medium",
  tiers: ["assumed"],
  retired: "the fix is slower on V8's top tiers (TurboFan 0.10–0.61x), though faster on JSC at 10 keys; see bench/FINDINGS.md, 2026-11-16",
  description: "`for (const [k, v] of Object.entries(o))` → `Object.keys` plus `o[k]`",
  why: "Object.entries allocates a [key, value] array per property, and destructuring each one goes through the iterator protocol. Keys plus an index load avoid all of that.",
  kinds: [K.ForOfStatement],
  check(node, ctx) {
    const l = entriesLoop(node);
    if (!l || l.single) return;
    const { n, init, obj, kind, keyName, valName } = l;
    if (!keyName || !valName || !ts.isIdentifier(keyName) || !isSimpleRef(obj)) return ctx.report(n.expression, ENTRIES);
    const body = n.statement;
    // `o as T` must keep its parentheses: `o as T[k]` would index the type, not the object.
    const target = ts.isParenthesizedExpression(obj) || unwrap(obj) === obj ? ctx.text(obj) : `(${ctx.text(obj)})`;
    const decl = `${kind} ${ctx.text(valName)} = ${target}[${keyName.text}];`;
    const indent = ctx.indentOf(n);
    const newBody = ts.isBlock(body)
      ? `{\n${indent}  ${decl}${ctx.sf.text.slice(body.getStart(ctx.sf) + 1, body.end)}`
      : `{\n${indent}  ${decl}\n${indent}  ${ctx.text(body)}\n${indent}}`;
    ctx.report(n.expression, `${ENTRIES} Values are read lazily after the fix, so writes inside the loop become visible.`, fix("assumed", [
      ctx.replace(init, `${kind} ${keyName.text}`),
      ctx.replace(n.expression, `Object.keys(${ctx.text(obj)})`),
      ctx.replace(body, newBody),
    ], `the loop does not write to \`${ctx.text(unwrap(obj))}\` or rely on getters running up front`));
  },
};

export const deleteProperty: RuleDef = {
  name: "delete-property",
  impact: "medium",
  tiers: [],
  description: "`delete obj.prop`",
  why: "Deleting a property usually drops the object from fast hidden-class mode into slow dictionary mode for good. Set it to undefined, or use a Map for dynamic keys. On arrays, delete leaves a hole.",
  kinds: [K.DeleteExpression],
  check(node, ctx) {
    const target = unwrap((node as ts.DeleteExpression).expression);
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return;
    const message = ctx.isArray(target.expression) === "yes"
      ? "`delete` on an array element leaves a hole and makes the array holey (slower element access); use splice or reassign."
      : "`delete` switches the object to slow dictionary mode; assign `undefined` or use a Map for dynamic keys.";
    ctx.report(node, message);
  },
};

const ZERO_CMP = new Set([
  K.EqualsEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken,
  K.GreaterThanToken,
]);

function keysLength(expr: ts.Expression) {
  const e = unwrap(expr);
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "length") return;
  return staticCall(unwrap(e.expression), "Object", "keys") ?? staticCall(unwrap(e.expression), "Object", "values");
}

export const objectKeysEmptiness: RuleDef = {
  name: "object-keys-emptiness",
  impact: "medium",
  tiers: [],
  description: "`Object.keys(o).length === 0` to test for an empty object",
  why: "This builds an array of every key just to see whether there is at least one. A `for (const k in o) { if (Object.hasOwn(o, k)) return false }` helper stops at the first key and allocates nothing.",
  kinds: [K.BinaryExpression, K.PropertyAccessExpression],
  check(node, ctx) {
    if (ts.isBinaryExpression(node)) {
      if (!ZERO_CMP.has(node.operatorToken.kind) || !isNumber(node.right, 0) || !keysLength(node.left)) return;
    } else if (!isBooleanContext(node) || !keysLength(node as ts.Expression)) return;
    ctx.report(node, "Emptiness check allocates every key; use a for-in early-exit helper.");
  },
};

const JSON_THRESHOLD = 10_000;

/** JSON text for a literal made only of JSON-compatible constants, or undefined. */
function toJson(node: ts.Expression): unknown {
  const e = unwrap(node);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number.isFinite(Number(e.text)) ? Number(e.text) : FAIL;
  if (ts.isPrefixUnaryExpression(e) && e.operator === K.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  if (e.kind === K.TrueKeyword) return true;
  if (e.kind === K.FalseKeyword) return false;
  if (e.kind === K.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(e)) {
    const out = e.elements.map((el) => (ts.isSpreadElement(el) || ts.isOmittedExpression(el) ? FAIL : toJson(el)));
    return out.includes(FAIL) ? FAIL : out;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) return FAIL;
      const key = ts.isIdentifier(p.name) || isStringLit(p.name) ? p.name.text
        : ts.isNumericLiteral(p.name) ? String(Number(p.name.text)) : undefined;
      if (key === undefined || key === "__proto__") return FAIL;
      const v = toJson(p.initializer);
      if (v === FAIL) return FAIL;
      out[key] = v;
    }
    return out;
  }
  return FAIL;
}
const FAIL = Symbol("not-json");

export const largeObjectLiteral: RuleDef = {
  name: "large-object-literal",
  impact: "medium",
  tiers: ["typed", "assumed"],
  recommended: false,
  obscure: true,
  description: "Large constant object/array literal → `JSON.parse('...')`",
  why: "For big constant data (over ~10 kB), the JSON parser is much faster than the JavaScript parser and compiler, which have to handle a far richer grammar (see V8's \"cost of JavaScript\" guidance). The fix loses the static type in TypeScript, so it is only applied automatically in JS files.",
  kinds: [K.ObjectLiteralExpression, K.ArrayLiteralExpression],
  check(node, ctx) {
    if (node.end - node.pos < JSON_THRESHOLD) return;
    let p = node.parent;
    while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent;
    if (ts.isPropertyAssignment(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) return;
    const json = toJson(node as ts.Expression);
    if (json === FAIL) return;
    const text = `JSON.parse(${ctx.quote(JSON.stringify(json))})`;
    ctx.report(node, "Large constant literal; `JSON.parse` of a string literal is faster to load.",
      fix(ctx.isTS ? "assumed" : "typed", [ctx.replace(node, text)], "nothing needs the literal's static type (`JSON.parse` returns `any`)", true));
  },
};

export const objectRules = [objectAssignToSpread, objectEntries, objectEntriesPair, deleteProperty, objectKeysEmptiness, largeObjectLiteral];
