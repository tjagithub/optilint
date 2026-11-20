import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validate } from "../src/validate.ts";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
// math-pow-to-mul measured faster on V8 but up to a third slower on JavaScriptCore (src/speedups.ts).
const CODE = "export const f = (x: number) => x ** 2;\n";

function rules(config: object | undefined) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-targets-")));
  fs.writeFileSync(path.join(d, "a.ts"), CODE);
  if (config) fs.writeFileSync(path.join(d, "optilint.json"), JSON.stringify(config));
  const r = Bun.spawnSync(["bun", CLI, "--format", "json", "a.ts"], { cwd: d });
  if (r.exitCode === 2) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString()).findings.map((f: { rule: string }) => f.rule);
}

test("only the targets' engines count against maxSlowdown", () => {
  expect(rules(undefined)).toEqual([]);
  expect(rules({ targets: ["node"] })).toEqual(["math-pow-to-mul"]);
  expect(rules({ targets: ["node", "chrome"] })).toEqual(["math-pow-to-mul"]);
  expect(rules({ targets: ["node", "bun"] })).toEqual([]);
  expect(rules({ targets: ["safari"] })).toEqual([]);
  expect(rules({ targets: [] })).toEqual([]);
});

test("unknown targets are errors with a suggestion", () => {
  expect(validate({ targets: ["nod", "firefox"] })).toEqual([
    'targets[0]: expected one of "node", "deno", "chrome", "edge", "bun", "safari", got "nod" (did you mean "node"?)',
    'targets[1]: expected one of "node", "deno", "chrome", "edge", "bun", "safari", got "firefox"',
  ]);
  expect(validate({ targets: "node" })).toEqual(["targets: expected an array"]);
});
