import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allRules, retiredRules } from "../src/rules/index.ts";
import { layer, run, UsageError } from "../src/runner.ts";
import { validate } from "../src/validate.ts";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const CODE = "export const a = Array.from(new Set([1])).map((x) => x * 2);\n"
  + "declare const o: Record<string, number>;\nfor (const [k, v] of Object.entries(o)) console.log(k, v);\n";
const hits = (only: string[]) => run({ cwd: os.tmpdir(), buffer: { file: "a.ts", text: CODE }, fix: false, layer: layer({ only }) })
  .results.flatMap((r) => r.findings.map((f) => f.rule));

describe("retired rules", () => {
  test("are kept, with a reason that points to the bench evidence", () => {
    expect(retiredRules.map((r) => r.name).sort()).toEqual(["array-from-map", "object-entries-pair"]);
    for (const r of retiredRules) expect(r.retired).toContain("bench/FINDINGS.md");
    expect(allRules.some((r) => r.retired)).toBe(false);
  });

  test("never run, not even through their group", () => {
    expect(hits(["arrays", "objects"])).toEqual([]);
  });

  test("naming one on the command line or in config gives the reason", () => {
    expect(() => layer({ only: ["array-from-map"] })).toThrow(UsageError);
    expect(() => layer({ only: ["array-from-map"] })).toThrow(/"array-from-map" is retired: the fix is slower/);
    expect(validate({ rules: { "object-entries-pair": "on" } })).toEqual([expect.stringMatching(/rules\.object-entries-pair: rule is retired: /)]);
    expect(validate({ rules: { arrays: { "array-from-map": "off" } } })).toEqual([expect.stringMatching(/rule is retired: /)]);
  });

  test("--explain still describes one", () => {
    const r = Bun.spawnSync(["bun", CLI, "--explain", "array-from-map"], { env: { ...process.env, NO_COLOR: "1" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("Retired, so it never runs: the fix is slower on every V8 and JSC tier");
  });

  test("are left out of the config schema", () => {
    const schema = fs.readFileSync(path.join(import.meta.dir, "..", "schema.json"), "utf8");
    for (const r of retiredRules) expect(schema).not.toContain(`"${r.name}"`);
  });
});
