import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, findConfig, loadConfig } from "../src/config.ts";

function dir(files: Record<string, string>) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-config-")));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
  return d;
}
const load = (d: string) => loadConfig(findConfig(d), {}, d);
const loadError = (d: string) => {
  try {
    load(d);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
};

describe("config files", () => {
  test("optilint.json may have comments and trailing commas", () => {
    const d = dir({ "optilint.json": '{\n  // fixes up to assumed\n  "tier": "assumed", /* and */ "ignore": ["gen",],\n}\n' });
    const config = load(d);
    expect(config.settingsFor(path.join(d, "a.ts")).tier).toBe("assumed");
    expect(config.selects(path.join(d, "gen", "x.ts"))).toBe(false);
  });

  test("optilint.jsonc is found too, and extends can point at one", () => {
    const d = dir({ "base.jsonc": '{ "tier": "exact", // base\n}', "optilint.jsonc": '{ "extends": ["./base.jsonc"] }' });
    expect(findConfig(d)).toBe(path.join(d, "optilint.jsonc"));
    expect(load(d).settingsFor(path.join(d, "a.ts")).tier).toBe("exact");
  });

  test("both names in one folder is an error", () => {
    const d = dir({ "optilint.json": "{}", "optilint.jsonc": "{}" });
    expect(() => findConfig(d)).toThrow(/both optilint\.json and optilint\.jsonc exist; keep one/);
  });

  test("syntax errors give the line and column", () => {
    expect(loadError(dir({ "optilint.json": '{\n  "tier": "typed"\n  "obscure": true\n}' }))).toMatch(/optilint\.json:3:3: ',' expected\./);
  });

  test("a root that is not an object, or no value at all, is an error", () => {
    for (const text of ["[1]", "3", "", "  // only a comment\n"]) {
      expect(loadError(dir({ "optilint.json": text }))).toEndWith("optilint.json: config must be a JSON object");
    }
  });

  test("package.json stays strict JSON", () => {
    const d = dir({ "package.json": '{ "optilint": { "tier": "exact" } }' });
    expect(load(d).settingsFor(path.join(d, "a.ts")).tier).toBe("exact");
    expect(loadConfig.bind(null, path.join(dir({ "package.json": '{ "optilint": {}, }' }), "package.json"))).toThrow(ConfigError);
  });
});
