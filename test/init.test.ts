import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { SCHEMA_URL } from "../src/init.ts";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

function dir(files: Record<string, string> = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-init-")));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), text);
  }
  return d;
}

function init(cwd: string) {
  const r = Bun.spawnSync(["bun", CLI, "--init"], { cwd });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("--init writes a config that loads", () => {
  const d = dir();
  const r = init(d);
  expect(r.code).toBe(0);
  expect(r.out).toContain("optilint.json");
  const file = path.join(d, "optilint.json");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ $schema: SCHEMA_URL, tier: "typed", rules: { preset: "recommended" } });
  expect(() => loadConfig(file, {}, d)).not.toThrow();
});

test("--init refuses a folder that already has a config", () => {
  const cases: Record<string, string>[] = [{ "optilint.jsonc": "{}" }, { "package.json": '{ "optilint": {} }' }];
  for (const files of cases) {
    const d = dir(files);
    const r = init(d);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`${Object.keys(files)[0]} already configures optilint`);
    expect(fs.existsSync(path.join(d, "optilint.json"))).toBe(false);
  }
});

test("--init in a subfolder extends the parent config", () => {
  const d = dir({ "optilint.json": '{ "minImpact": "medium" }', "pkg/a.ts": "" });
  expect(init(path.join(d, "pkg")).code).toBe(0);
  const file = path.join(d, "pkg", "optilint.json");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).extends).toEqual(["../optilint.json"]);
  expect(() => loadConfig(file, {}, path.join(d, "pkg"))).not.toThrow();
});
