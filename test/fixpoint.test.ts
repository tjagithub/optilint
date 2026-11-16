import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { PRELUDE } from "../bench/case.ts";
import { loadCases } from "../bench/gen.ts";
import { applies, lint } from "../src/core/engine.ts";
import { allRules } from "../src/rules/index.ts";

// Two rules that undo each other would rewrite the same code until the pass limit, leaving fixes pending.
const settings = { tier: "assumed", obscure: true } as const;
const active = new Set(allRules.map((r) => r.name));
const cases = (await loadCases()).flatMap(({ cases }) => cases).filter((c) => active.has(c.rule));

test.each(cases.map((c, i) => [c.name ? `${c.rule}:${c.name}` : c.rule, c, i] as const))("every rule together settles on %s", (_, c, i) => {
  const file = path.join(os.tmpdir(), `optilint-fixpoint-${i}.ts`);
  const [result] = lint([file], { rules: allRules, fix: true, settings: () => settings }, new Map([[file, PRELUDE + c.code]]));
  expect(result!.fixesApplied).toBeGreaterThan(0);
  expect(result!.findings.filter((f) => f.fix && applies(f.fix, settings)).map((f) => f.rule)).toEqual([]);
});
