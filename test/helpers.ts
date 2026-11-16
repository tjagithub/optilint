import type ts from "typescript";
import { lint } from "../src/engine.ts";
import type { Tier } from "../src/types.ts";

/** The highest tier to apply; obscure fixes are included. */
type FixMode = Tier | "none";
import { allRules, ruleByName } from "../src/rules/index.ts";

const OPTIONS: ts.CompilerOptions = { types: [], strict: true };

interface RunOptions {
  rule?: string;
  file?: string;
  fix?: FixMode;
  compilerOptions?: ts.CompilerOptions;
}

export function run(code: string, { rule, file = "/virtual/test.ts", fix = "none", compilerOptions }: RunOptions = {}) {
  const rules = rule ? [ruleByName.get(rule)!] : allRules;
  if (rule && !rules[0]) throw new Error(`unknown rule ${rule}`);
  const [result] = lint([file], {
    rules, fix: fix !== "none", settings: () => ({ tier: fix === "none" ? "typed" : fix, obscure: true }),
    compilerOptions: { ...OPTIONS, ...compilerOptions },
    onRuleError: (r, _f, e) => { throw new Error(`${r}: ${(e as Error).stack}`); },
  }, new Map([[file, code]]));
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
