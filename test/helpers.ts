import type ts from "typescript";
import { lint } from "../src/core/engine.ts";
import type { EsTarget } from "../src/core/es.ts";
import type { Tier } from "../src/core/types.ts";

/** The highest tier to apply; obscure fixes are included. */
type FixMode = Tier | "none";
import { allRules, retiredByName, ruleByName } from "../src/rules/index.ts";

const OPTIONS: ts.CompilerOptions = { types: [], strict: true };

interface RunOptions {
  rule?: string;
  file?: string;
  fix?: FixMode;
  compilerOptions?: ts.CompilerOptions;
  /** The config's `target`. */
  target?: EsTarget;
  /** More files for the program (path → contents); only `file`'s result is returned. */
  extra?: Record<string, string>;
}

export function run(code: string, { rule, file = "/virtual/test.ts", fix = "none", compilerOptions, target, extra = {} }: RunOptions = {}) {
  // Retired rules never run in optilint, but their tests still call them by name.
  const rules = rule ? [(ruleByName.get(rule) ?? retiredByName.get(rule))!] : allRules;
  if (rule && !rules[0]) throw new Error(`unknown rule ${rule}`);
  const [result] = lint([file, ...Object.keys(extra)], {
    rules, fix: fix !== "none", settings: () => ({ tier: fix === "none" ? "typed" : fix, obscure: true, ...(target ? { target } : {}) }),
    compilerOptions: { ...OPTIONS, ...compilerOptions },
    onRuleError: (r, _f, e) => { throw new Error(`${r}: ${(e as Error).stack}`); },
  }, new Map([[file, code], ...Object.entries(extra)]));
  return result!;
}

/** Rule names reported for `code`. */
export function rulesHit(code: string, opts: RunOptions = {}) {
  return run(code, opts).findings.map((f) => f.rule);
}

/** Output after applying fixes for one rule (safe by default). */
export function fixed(code: string, rule: string, fix: FixMode = "typed", opts: RunOptions = {}) {
  return run(code, { ...opts, rule, fix }).output;
}
