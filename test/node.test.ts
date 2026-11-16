import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globMatch } from "../src/core/glob.ts";

describe("globMatch", () => {
  const cases: [string, string, boolean][] = [
    ["src/**", "src/a/b.ts", true],
    ["src/**", "lib/a.ts", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "x/y/a.test.ts", true],
    ["**/*.test.ts", "x/a.test.tsx", false],
    ["src/**/gen/*.ts", "src/gen/a.ts", true],
    ["src/**/gen/*.ts", "src/x/y/gen/a.ts", true],
    ["*.ts", "a/b.ts", false],
    ["*.{ts,tsx}", "a.tsx", true],
    ["?.js", "ab.js", false],
    ["[ab].js", "b.js", true],
    ["[!ab].js", "b.js", false],
    ["a.b", "axb", false],
    ["gen", "gen", true],
  ];
  for (const [glob, file, want] of cases) test(`${glob} ~ ${file}`, () => expect(globMatch(glob, file)).toBe(want));
});

// The VS Code extension ships this bundle and runs it on Electron's Node, without Bun.
const node = Bun.which("node");
describe.skipIf(!node)("bundle on Node", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-bundle-"));
  beforeAll(() => {
    const r = spawnSync("bun", [path.join(import.meta.dir, "..", "scripts", "bundle.ts"), out], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, "optilint.mjs"), "utf8")).not.toContain(path.join(import.meta.dir, ".."));
  }, 60_000);
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  test("lints stdin with the type checker's libs", () => {
    const r = spawnSync(node!, [path.join(out, "optilint.mjs"), "--format=json", "--stdin-filename=a.ts"], {
      cwd: out,
      encoding: "utf8",
      input: "const xs: number[] = [1];\nexport const y = xs.filter((x) => x > 0).length > 0;\n",
    });
    expect(r.stderr).toBe("");
    const { findings } = JSON.parse(r.stdout);
    expect(findings.map((f: { rule: string; fix: { tier: string } }) => `${f.rule}:${f.fix.tier}`)).toEqual(["filter-length-to-some:typed"]);
  });

  test("carries the skill", () => {
    expect(fs.readFileSync(path.join(out, "skills", "optilint", "SKILL.md"), "utf8")).toStartWith("---\nname: optilint\n");
  });

  test("lists rules with the tool name", () => {
    const r = spawnSync(node!, [path.join(out, "optilint.mjs"), "--list-rules", "--format=json"], { encoding: "utf8" });
    expect(JSON.parse(r.stdout).tool.name).toBe("optilint");
  });
});
