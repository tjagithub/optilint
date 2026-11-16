import ts from "typescript";
import { isAssignment, staticCall, unwrap } from "../../core/ast.ts";
import type { RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

/** `this.name = ...` assignments in `body`, into arrow functions (same `this`) but not other functions. */
function thisAssignments(body: ts.Node, out: ts.BinaryExpression[] = []) {
  ts.forEachChild(body, (n) => {
    if (isAssignment(n) && n.operatorToken.kind === K.EqualsToken) {
      const left = unwrap(n.left);
      if (ts.isPropertyAccessExpression(left) && left.expression.kind === K.ThisKeyword && ts.isIdentifier(left.name)) out.push(n);
    }
    if (!ts.isFunctionLike(n) || ts.isArrowFunction(n)) thisAssignments(n, out);
  });
  return out;
}

const propName = (b: ts.BinaryExpression) => ((unwrap(b.left) as ts.PropertyAccessExpression).name as ts.Identifier).text;

export const lateProperty: RuleDef = {
  name: "late-property",
  impact: "low",
  tiers: [],
  description: "`this.x = ...` in a method for a field the class never declares or sets in its constructor",
  why: "Engines give objects a shape (hidden class, Structure) from the properties they get at construction. Adding one later moves every instance to a new shape and can grow its property storage, and code that sees instances from before and after becomes polymorphic. Declare the field, or set it in the constructor (`this.x = undefined`).",
  kinds: [K.ClassDeclaration, K.ClassExpression],
  check(node, ctx) {
    const cls = node as ts.ClassLikeDeclaration;
    const declared = new Set<string>();
    for (const m of cls.members) {
      if (m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name) || ts.isStringLiteral(m.name))) declared.add(m.name.text);
      if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) if (ts.isIdentifier(p.name) && p.modifiers?.length) declared.add(p.name.text);
        if (m.body) for (const a of thisAssignments(m.body)) declared.add(propName(a));
      }
    }
    // Without its own constructor a subclass may get the field from the base's.
    if (cls.heritageClauses?.some((h) => h.token === K.ExtendsKeyword) && !cls.members.some(ts.isConstructorDeclaration)) return;
    const reported = new Set<string>();
    for (const m of cls.members) {
      const isStatic = ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Static;
      const body = (ts.isMethodDeclaration(m) || ts.isAccessor(m)) && !isStatic ? m.body : undefined;
      for (const a of body ? thisAssignments(body) : []) {
        const name = propName(a);
        if (declared.has(name) || reported.has(name)) continue;
        reported.add(name);
        ctx.report(a, `\`this.${name}\` is first added outside the constructor, which changes the object's shape; declare it, or set it in the constructor.`);
      }
    }
  },
};

export const prototypeMutation: RuleDef = {
  name: "prototype-mutation",
  impact: "medium",
  tiers: [],
  description: "`Object.setPrototypeOf`, `Reflect.setPrototypeOf` or `__proto__ =` on an existing object",
  why: "Changing an object's prototype after it exists invalidates the engine's assumptions about it and about code that has seen it; V8 and JSC both deoptimize, and the object may stay slow. Create it with the right prototype: `Object.create(proto)`, a class, or `{ __proto__: proto, ... }` in a literal.",
  kinds: [K.CallExpression, K.BinaryExpression],
  check(node, ctx) {
    if (ts.isBinaryExpression(node)) {
      const left = unwrap(node.left);
      if (node.operatorToken.kind === K.EqualsToken && ts.isPropertyAccessExpression(left) && left.name.text === "__proto__") {
        ctx.report(node, "Assigning `__proto__` changes the prototype of an existing object; create it with `Object.create(proto)` instead.");
      }
      return;
    }
    const m = staticCall(node, "Object", "setPrototypeOf") ?? staticCall(node, "Reflect", "setPrototypeOf");
    if (!m || m.args.length !== 2) return;
    // `Object.setPrototypeOf(this, X.prototype)` in a constructor is the usual fix for subclassing Error on ES5.
    const ctor = ts.findAncestor(node, ts.isFunctionLike);
    if (unwrap(m.args[0]!).kind === K.ThisKeyword && ctor && ts.isConstructorDeclaration(ctor)) return;
    const fresh = ts.isObjectLiteralExpression(unwrap(m.args[0]!));
    ctx.report(node, fresh
      ? "`setPrototypeOf` on a fresh literal; use `Object.create(proto)` or `{ __proto__: proto, ... }`."
      : "`setPrototypeOf` changes the prototype of an existing object, which deoptimizes code that uses it; create it with the right prototype.");
  },
};

export const shapeRules = [lateProperty, prototypeMutation];
