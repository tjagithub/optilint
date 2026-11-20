// TS-only: what a low `target` makes TypeScript emit. Each rule reports once per file, at the first case, with a count;
// the fix is in tsconfig. Measured in bench/emit (`bench/FINDINGS.md`, 2026-11-20).
import ts from "typescript";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const T = ts.ScriptTarget;

/** TypeScript writes this file's JavaScript (not a bundler, not `--noEmit`); returns the target it emits. */
function emitTarget(ctx: RuleContext): ts.ScriptTarget | undefined {
  if (!ctx.emits || !ctx.isTS || ctx.sf.isDeclarationFile) return undefined;
  return ctx.options.target ?? T.LatestStandard;
}

const targetName = (t: ts.ScriptTarget) => (t === T.ES5 ? "ES5" : t === T.ES3 ? "ES3" : `ES${2015 + t - T.ES2015}`);

function collect(sf: ts.SourceFile, match: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (match(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const isAsync = (n: ts.Node) => ts.isFunctionLike(n) && !!ts.getModifiers(n as ts.HasModifiers)?.some((m) => m.kind === K.AsyncKeyword);

export const downlevelAsync: RuleDef = {
  name: "downlevel-async",
  impact: "medium",
  tiers: [],
  description: "`async` compiled to generators by a `target` below ES2017",
  why: "Below ES2017, TypeScript turns each async function into a generator driven by its `__awaiter` helper (async generators and `for await` need ES2018). Calls and awaits measured 2–14x slower than native async on V8 and JSC, at every tier. Every engine since 2017 runs native async, so raise `target` unless you ship to older ones.",
  kinds: [K.SourceFile],
  check(node, ctx) {
    const target = emitTarget(ctx);
    if (target === undefined || target >= T.ES2018) return;
    const found = collect(node as ts.SourceFile, (n) =>
      (isAsync(n) && (target < T.ES2017 || !!(n as ts.FunctionLikeDeclaration).asteriskToken)) ||
      (ts.isForOfStatement(n) && !!n.awaitModifier));
    if (!found.length) return;
    const generators = found.some((n) => !ts.isFunctionLike(n) || !!(n as ts.FunctionLikeDeclaration).asteriskToken);
    const needs = target < T.ES2017 && !generators ? "ES2017" : "ES2018";
    ctx.report(found[0]!, `\`target: ${targetName(target)}\` compiles ${plural(found.length, "async function or loop", "async functions and loops")} in this file to generators (2–14x slower); set \`target\` to ${needs} or later in tsconfig.`);
  },
};

const isInstanceField = (n: ts.Node): n is ts.PropertyDeclaration =>
  ts.isPropertyDeclaration(n) && !ts.getModifiers(n)?.some((m) => m.kind === K.StaticKeyword || m.kind === K.DeclareKeyword || m.kind === K.AbstractKeyword);

export const defineClassFields: RuleDef = {
  name: "define-class-fields",
  impact: "high",
  tiers: [],
  description: "Class fields emitted as `Object.defineProperty` (`useDefineForClassFields` below ES2022)",
  why: "With `useDefineForClassFields: true` and a `target` below ES2022, TypeScript writes every instance field as an `Object.defineProperty` call in the constructor. Constructing such objects measured 4–100x slower than native fields or plain assignment, on V8 and JSC. Set `target` to ES2022 or later (native fields keep the same semantics), or drop the option if nothing relies on define semantics.",
  kinds: [K.SourceFile],
  check(node, ctx) {
    const target = emitTarget(ctx);
    if (target === undefined || target >= T.ES2022 || ctx.options.useDefineForClassFields !== true) return;
    const fields = collect(node as ts.SourceFile, (n) => isInstanceField(n) && !ts.isPrivateIdentifier(n.name));
    if (!fields.length) return;
    ctx.report(fields[0]!, `\`useDefineForClassFields\` with \`target: ${targetName(target)}\` emits ${plural(fields.length, "class field", "class fields")} in this file as \`Object.defineProperty\` calls (4–100x slower to construct); set \`target\` to ES2022 or later in tsconfig.`);
  },
};

export const downlevelPrivateFields: RuleDef = {
  name: "downlevel-private-fields",
  impact: "high",
  tiers: [],
  description: "`#private` members compiled to WeakMaps by a `target` below ES2022",
  why: "Below ES2022, TypeScript emulates `#private` fields and methods with a WeakMap or WeakSet per member and a checking helper on every access. Construction and access measured 5x to over 200x slower than native private fields, on V8 and JSC. Raise `target` to ES2022, or use TypeScript's `private` keyword, which emits a plain property.",
  kinds: [K.SourceFile],
  check(node, ctx) {
    const target = emitTarget(ctx);
    if (target === undefined || target >= T.ES2022) return;
    const members = collect(node as ts.SourceFile, (n) => ts.isClassElement(n) && !!n.name && ts.isPrivateIdentifier(n.name));
    if (!members.length) return;
    ctx.report(members[0]!, `\`target: ${targetName(target)}\` emulates ${plural(members.length, "`#private` member", "`#private` members")} in this file with WeakMaps (5–200x+ slower); set \`target\` to ES2022 or later in tsconfig, or use the \`private\` keyword.`);
  },
};

export const emitRules: readonly RuleDef[] = [downlevelAsync, defineClassFields, downlevelPrivateFields];
