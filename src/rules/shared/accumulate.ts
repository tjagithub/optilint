import ts from "typescript";
import { isFunction, methodCall, repeatingAncestor, unwrap, walk } from "../../core/ast.ts";
import { fix } from "../../core/fix.ts";
import type { Edit, RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;

function returnedExpressions(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  walk(fn.body, (n) => {
    if (ts.isFunctionLike(n)) return false;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
  });
  return out;
}

function isRef(node: ts.Node | undefined, name: string) {
  return !!node && ts.isIdentifier(node) && node.text === name;
}

function propertyTarget(acc: string, p: ts.ObjectLiteralElementLike, ctx: RuleContext) {
  if (ts.isShorthandPropertyAssignment(p)) return { target: `${acc}.${p.name.text}`, value: p.name.text };
  if (!ts.isPropertyAssignment(p)) return;
  const value = ctx.text(p.initializer);
  if (ts.isIdentifier(p.name) || ts.isPrivateIdentifier(p.name)) return { target: `${acc}.${p.name.text}`, value };
  if (ts.isComputedPropertyName(p.name)) return { target: `${acc}[${ctx.text(p.name.expression)}]`, value };
  return { target: `${acc}[${ctx.text(p.name)}]`, value };
}

/** Rewrite `{...acc, k: v}` / `[...acc, x]` so it mutates `acc`. */
function mutatingRewrite(expr: ts.Expression, acc: string, ctx: RuleContext): string | undefined {
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e)) {
    const [first, ...rest] = e.elements;
    if (!first || !ts.isSpreadElement(first) || !isRef(first.expression, acc)) return;
    if (rest.some((r) => ts.isOmittedExpression(r))) return;
    if (!rest.length) return acc;
    return `(${acc}.push(${rest.map((r) => ctx.text(r)).join(", ")}), ${acc})`;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const [first, ...rest] = e.properties;
    if (!first || !ts.isSpreadAssignment(first) || !isRef(first.expression, acc)) return;
    if (!rest.length) return acc;
    const parts = rest.map((p) => propertyTarget(acc, p, ctx));
    const readsAcc = rest.some((p) => {
      let hit = false;
      walk(p, (n) => { if (isRef(n, acc)) hit = true; }, true);
      return hit;
    });
    if (parts.every(Boolean) && (rest.length === 1 || !readsAcc)) {
      return `(${parts.map((p) => `${p!.target} = ${p!.value}`).join(", ")}, ${acc})`;
    }
    return `Object.assign(${acc}, { ${rest.map((r) => ctx.text(r)).join(", ")} })`;
  }
}

/** Uses of `acc` other than spreading it or reading its members could observe the mutation. */
function accEscapes(fn: ts.ArrowFunction | ts.FunctionExpression, acc: string) {
  let escapes = false;
  walk(fn.body, (n) => {
    if (!isRef(n, acc)) return;
    const p = n.parent;
    if ((ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) && p.expression === n) return;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n &&
      !ts.isCallExpression(p.parent)) return;
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === n)) return;
    escapes = true;
  }, true);
  return escapes;
}

export const spreadInAccumulator: RuleDef = {
  name: "spread-in-accumulator",
  impact: "high",
  tiers: ["typed", "assumed"],
  description: "`xs.reduce((acc, x) => ({ ...acc, [k]: v }), {})` → mutate `acc`",
  why: "Spreading the accumulator copies everything collected so far on every step, which makes reduce O(n²). The initial value is a fresh literal, so mutating it is invisible to callers.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const m = methodCall(node, new Set(["reduce", "reduceRight"]));
    if (!m || m.args.length !== 2) return;
    const [fn, init] = m.args as [ts.Expression, ts.Expression];
    const seed = unwrap(init);
    const fresh = (ts.isObjectLiteralExpression(seed) || ts.isArrayLiteralExpression(seed));
    if (!isFunction(fn) || !fresh || fn.asteriskToken) return;
    const param = fn.parameters[0];
    if (!param || !ts.isIdentifier(param.name)) return;
    const acc = param.name.text;
    const edits: Edit[] = [];
    let first: ts.Expression | undefined;
    for (const ret of returnedExpressions(fn)) {
      const text = mutatingRewrite(ret, acc, ctx);
      if (text === undefined) continue;
      first ??= ret;
      edits.push(ctx.replace(ret, text));
    }
    if (!first) return;
    ctx.report(first, `Spreading \`${acc}\` copies the accumulator on every step (O(n²)); mutate it instead.`,
      fix(accEscapes(fn, acc) ? "assumed" : "typed", edits, `nothing else holds a reference to an earlier \`${acc}\``));
  },
};

export const copyInLoop: RuleDef = {
  name: "accumulate-by-copy-in-loop",
  impact: "high",
  tiers: ["assumed"],
  description: "`xs = [...xs, x]` / `xs = xs.concat(x)` / `o = {...o, k: v}` inside a loop",
  why: "Rebuilding the collection on each iteration copies everything gathered so far: O(n²) time and garbage. Push or assign in place.",
  kinds: [K.BinaryExpression],
  check(node, ctx) {
    const n = node as ts.BinaryExpression;
    if (n.operatorToken.kind !== K.EqualsToken || !ts.isIdentifier(n.left) || !repeatingAncestor(n)) return;
    const name = n.left.text;
    const right = unwrap(n.right);
    const concat = methodCall(right, "concat");
    if (concat && isRef(unwrap(concat.object), name)) {
      ctx.report(n, `\`${name} = ${name}.concat(...)\` copies the array every iteration; push instead.`);
      return;
    }
    const text = mutatingRewrite(right, name, ctx);
    if (text === undefined || text === name) return;
    const tail = `, ${name})`;
    const stmt = text.startsWith("(") && text.endsWith(tail) ? text.slice(1, -tail.length) : text;
    const rewrite = ts.isExpressionStatement(n.parent) ? fix("assumed", [ctx.replace(n, stmt)], `nothing else holds a reference to the old \`${name}\``) : undefined;
    ctx.report(n, `Re-spreading \`${name}\` copies it every iteration (O(n²)); mutate it in place.`, rewrite);
  },
};

export const accumulateRules = [spreadInAccumulator, copyInLoop];
