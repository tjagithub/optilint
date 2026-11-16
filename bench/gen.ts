import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { layer, run } from "../src/runner.ts";
import { type Case, PRELUDE } from "./case.ts";

/** Fixable rules without a bench, and why a per-call CPU bench cannot show their gain. */
export const SKIPPED: Record<string, string> = {
  "sequential-await": "the gain is concurrency (overlapping waits), not CPU time per call",
  "large-object-literal": "the gain is in parsing and compiling at load time, not per call",
};

export const CASES_DIR = path.join(import.meta.dirname, "cases");

export interface Job {
  id: string;
  rule: string;
  /** Module URL of the case file, and the case's index in its `cases`. */
  caseUrl: string;
  index: number;
  sizes: readonly number[];
  /** Module URLs of the transpiled before and after code. */
  before: string;
  after: string;
  /** TypeScript before and after the fix, for `--show`. */
  source: { before: string; after: string };
}

export async function loadCases(): Promise<{ file: string; cases: Case[] }[]> {
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith(".ts")).sort();
  return Promise.all(files.map(async (f) => {
    const file = path.join(CASES_DIR, f);
    return { file, cases: ((await import(pathToFileURL(file).href)) as { cases: Case[] }).cases };
  }));
}

const JS: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false };

/** Fixes each case `pick` keeps, with only its rule on (assumed tier, obscure fixes too), and writes both versions to `outDir`. */
export function generate(file: string, cases: readonly Case[], outDir: string, pick: (c: Case) => boolean = () => true): Job[] {
  // `index` must be the position in the whole file: child.ts looks the case up there.
  return cases.flatMap((c, index) => (pick(c) ? [{ c, index }] : [])).map(({ c, index }) => {
    const id = c.name ? `${c.rule}:${c.name}` : c.rule;
    const base = path.join(outDir, id.replace(/[^\w-]/g, "_"));
    const before = PRELUDE + c.code.trim() + "\n";
    const { results, errors } = run({
      cwd: outDir, buffer: { file: `${base}.ts`, text: before }, fix: true,
      layer: layer({ only: [c.rule], tier: "assumed", obscure: true }),
    });
    if (errors.length) throw new Error(`${id}: ${errors.join("; ")}`);
    const after = results[0]?.output ?? before;
    if (after === before) throw new Error(`${id}: optilint made no fix, so the case no longer matches the rule`);
    const emit = (kind: string, text: string) => {
      const out = `${base}.${kind}.mjs`;
      fs.writeFileSync(out, ts.transpileModule(text, { compilerOptions: JS }).outputText);
      return pathToFileURL(out).href;
    };
    const caseUrl = pathToFileURL(file).href;
    return { id, rule: c.rule, caseUrl, index, sizes: c.sizes, before: emit("before", before), after: emit("after", after), source: { before, after } };
  });
}
