import ts from "typescript";
import { boundNames, identifiersIn, repeatingAncestor, unwrap } from "../ast.ts";
import { fix } from "../fix.ts";
import type { RuleDef } from "../types.ts";

const K = ts.SyntaxKind;

export const awaitInLoop: RuleDef = {
  name: "await-in-loop",
  impact: "high",
  tiers: [],
  description: "`await` inside a loop body",
  why: "Each iteration waits for the previous one, so total time is the sum of all latencies. If iterations are independent, start them all and `await Promise.all(...)` (or batch them to bound concurrency).",
  kinds: [K.AwaitExpression],
  check(node, ctx) {
    const loop = repeatingAncestor(node, false);
    if (!loop || (ts.isForOfStatement(loop) && loop.awaitModifier)) return;
    ctx.report(node, "Sequential `await` in a loop; run independent iterations concurrently with `Promise.all`.");
  },
};

interface AwaitDecl {
  stmt: ts.VariableStatement;
  kind: string;
  name: ts.BindingName;
  expr: ts.Expression;
}

function awaitDecl(stmt: ts.Statement): AwaitDecl | undefined {
  if (!ts.isVariableStatement(stmt)) return;
  const list = stmt.declarationList;
  if (list.declarations.length !== 1 || !(list.flags & ts.NodeFlags.BlockScoped)) return;
  const d = list.declarations[0]!;
  const init = d.initializer && unwrap(d.initializer);
  if (!init || !ts.isAwaitExpression(init) || d.type) return;
  const scope = list.flags & ts.NodeFlags.BlockScoped;
  if (scope !== ts.NodeFlags.Let && scope !== ts.NodeFlags.Const) return;
  return { stmt, kind: list.flags & ts.NodeFlags.Const ? "const" : "let", name: d.name, expr: init.expression };
}

export const sequentialAwait: RuleDef = {
  name: "sequential-await",
  impact: "high",
  tiers: ["assumed"],
  description: "Back-to-back independent `await`s → `Promise.all`",
  why: "`const a = await f(); const b = await g();` waits for f before starting g, even though g never reads `a`. Promise.all overlaps them. (Unsafe: g now starts before f settles, and a rejection in f no longer prevents g from running.)",
  kinds: [K.Block, K.SourceFile, K.ModuleBlock, K.CaseClause, K.DefaultClause],
  check(node, ctx) {
    const stmts = (node as ts.Block).statements ?? (node as ts.CaseClause).statements;
    let run: AwaitDecl[] = [];
    const flush = () => {
      if (run.length >= 2) report(run);
      run = [];
    };
    const report = (group: AwaitDecl[]) => {
      const indent = ctx.indentOf(group[0]!.stmt);
      const names = group.map((g) => ctx.text(g.name)).join(", ");
      const exprs = group.map((g) => ctx.text(g.expr)).join(`,\n${indent}  `);
      const text = `${group[0]!.kind} [${names}] = await Promise.all([\n${indent}  ${exprs},\n${indent}]);`;
      const first = group[0]!.stmt;
      const last = group.at(-1)!.stmt;
      ctx.report(first, `${group.length} independent awaits run one after another; start them together with \`Promise.all\`.`,
        fix("assumed", [{ start: first.getStart(ctx.sf), end: last.end, text }], "each call works without the earlier ones having settled"));
    };
    for (const stmt of stmts) {
      const d = awaitDecl(stmt);
      if (!d) { flush(); continue; }
      const bound = new Set(run.flatMap((r) => boundNames(r.name)));
      const ids = identifiersIn(d.expr);
      const dependent = [...ids].some((id) => bound.has(id));
      if (dependent || (run[0] && run[0].kind !== d.kind)) flush();
      run.push(d);
    }
    flush();
  },
};

export const asyncRules = [awaitInLoop, sequentialAwait];
