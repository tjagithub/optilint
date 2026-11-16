import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRELUDE } from "../bench/case.ts";
import { loadCases } from "../bench/gen.ts";
import { newestResults, OUT, render } from "../bench/speedups.ts";
import { allRules, retiredRules } from "../src/rules/index.ts";
import { layer, run, UsageError } from "../src/runner.ts";
import { offByDefault, parseSlowdown, percent, worstSlowdown } from "../src/slowdown.ts";
import { SPEEDUPS } from "../src/speedups.ts";
import { validate } from "../src/validate.ts";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const hits = (text: string, only: string[], maxSlowdown?: string) =>
  run({ cwd: os.tmpdir(), buffer: { file: "a.ts", text }, fix: false, layer: layer({ only, maxSlowdown }) })
    .results.flatMap((r) => r.findings.map((f) => f.rule));
const explain = (rule: string) =>
  Bun.spawnSync(["bun", CLI, "--explain", rule], { env: { ...process.env, NO_COLOR: "1" } }).stdout.toString();
// Each bench case is code its rule finds, so it shows whether the rule runs.
const active = new Set(allRules.map((r) => r.name));
const cases = (await loadCases()).flatMap(({ cases }) => cases).filter((c) => active.has(c.rule));

describe("maxSlowdown", () => {
  test("src/speedups.ts is generated from the newest bench results", () => {
    expect(fs.readFileSync(OUT, "utf8")).toBe(render(newestResults()).text);
  });

  test("every measured rule exists", () => {
    const known = new Set([...allRules, ...retiredRules].map((r) => r.name));
    expect(Object.keys(SPEEDUPS).filter((r) => !known.has(r))).toEqual([]);
  });

  test("parses percentages and any", () => {
    expect(["10%", "0%", "2.5%", "any"].map(parseSlowdown)).toEqual([0.1, 0, 0.025, Infinity]);
    expect(["10", "-5%", "1e1%", "", 10, null].map(parseSlowdown)).toEqual(Array(6).fill(undefined));
    expect([0.0101, 0.34, 0.1].map(percent)).toEqual(["2%", "34%", "10%"]);
  });

  test.each(cases.map((c) => [c.name ? `${c.rule}:${c.name}` : c.rule, c] as const))("%s runs only within the allowed slowdown", (_, c) => {
    const text = PRELUDE + c.code;
    const slow = worstSlowdown(c.rule) ?? 0;
    expect(hits(text, [c.rule])).toEqual(slow <= 0.1 ? [c.rule] : []);
    expect(hits(text, [c.rule], "any")).toEqual([c.rule]);
    expect(hits(text, [c.rule], "0%")).toEqual(slow === 0 ? [c.rule] : []);
    expect(hits(text, [c.rule], percent(slow))).toEqual([c.rule]);
  });

  test("rules without a measured fix always run", () => {
    const code = "declare const xs: number[];\nexport const y = xs.filter((x) => x > 0).map((x) => x * 2);\n";
    expect(worstSlowdown("chained-array-methods")).toBeUndefined();
    expect(hits(code, ["chained-array-methods"], "0%")).toEqual(["chained-array-methods"]);
  });

  test("bad values are usage or config errors", () => {
    expect(() => layer({ maxSlowdown: "10" })).toThrow(UsageError);
    expect(() => layer({ maxSlowdown: "-5%" })).toThrow(/invalid --max-slowdown: -5% \(a percentage such as 10%, or any\)/);
    expect(validate({ maxSlowdown: 10 })).toEqual(['maxSlowdown: expected a percentage such as "10%", or "any", got 10']);
    expect(validate({ maxSlowdown: "2.5%" })).toEqual([]);
    const r = Bun.spawnSync(["bun", CLI, "--max-slowdown", "x", "--stdin-filename", "a.ts"], { stdin: Buffer.from("") });
    expect(r.exitCode).toBe(2);
  });

  test("--explain shows the measured range, and why a rule is off", () => {
    const measured = Object.keys(SPEEDUPS).find((n) => active.has(n))!;
    expect(explain(measured)).toMatch(/Measured \d{4}-\d\d-\d\d \(before ÷ after time over every tier\): V8 [\d.]+–[\d.]+x, JSC /);
    const off = allRules.find((r) => offByDefault(r.name));
    if (off) expect(explain(off.name)).toContain(`set maxSlowdown to ${percent(worstSlowdown(off.name)!)} or more to run it.`);
  });
});
