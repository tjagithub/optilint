import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema } from "../src/schema.ts";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const CODE = "const xs = [1, 2, 3];\nconst a = xs.filter((x) => x > 1)[0];\nconst t = new Date().getTime();\n";

function cli(args: string[], stdin?: string, cwd = os.tmpdir()) {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A temp project holding `files` (path → contents). */
function project(files: Record<string, string>) {
  // Real path: on macOS the child's cwd resolves /var to /private/var.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-cli-")));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe("cli", () => {
  test("stdin with JSON output carries positions, tiers and fix edits", () => {
    const r = cli(["--stdin-filename", "buf.js", "--format", "json"], CODE);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ version: 1, tool: { name: "optilint" } });
    expect(out.findings.map((f: { rule: string }) => f.rule)).toEqual(["filter-first", "date-now"]);
    const [first, second] = out.findings;
    expect(first).toMatchObject({ group: "arrays", line: 2, col: 11, endLine: 2, endCol: 37, description: expect.stringContaining("find") });
    expect(first.fix).toMatchObject({ tier: "typed", edits: [{ text: "xs.find((x) => x > 1)" }] });
    expect(CODE.slice(first.fix.edits[0].start, first.fix.edits[0].end)).toBe("xs.filter((x) => x > 1)[0]");
    expect(second.fix.tier).toBe("exact");
  });

  test("stdin with --fix prints the multi-pass result", () => {
    const r = cli(["--stdin-filename", "buf.js", "--fix"], "const xs = [1];\nxs.map((x) => console.log(x));\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("for (let i = 0, len = xs.length; i < len; i++) {");
  });

  test("clean stdin exits 0 with no findings", () => {
    const r = cli(["--stdin-filename", "buf.ts", "--format", "json"], "export const x = 1;\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).findings).toEqual([]);
  });

  test("--list-rules --format json lists metadata", () => {
    const { rules } = JSON.parse(cli(["--list-rules", "--format", "json"]).out);
    expect(rules.length).toBeGreaterThan(30);
    expect(rules.find((r: { name: string }) => r.name === "bitwise-trunc"))
      .toMatchObject({ group: "misc", tiers: ["assumed"], recommended: false, obscure: true, why: expect.any(String) });
  });

  test("unknown rules are a usage error with a suggestion", () => {
    const r = cli(["--rule", "filter-frist", "--stdin-filename", "a.js"], "");
    expect(r.code).toBe(2);
    expect(r.err).toContain('did you mean "filter-first"?');
  });

  test("unknown or incomplete flags are a usage error, not a stack trace", () => {
    for (const [args, message] of [[["--nope"], "Unknown option '--nope'"], [["--tier"], "argument missing"]] as const) {
      const r = cli([...args]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
      expect(r.err).toContain("--help");
      expect(r.err).not.toContain("    at ");
    }
  });

  test("--version prints the package version", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"));
    const r = cli(["--version"]);
    expect(r).toMatchObject({ code: 0, out: `optilint ${version}\n` });
  });

  test("the committed schema.json matches the rules", () => {
    const committed = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "schema.json"), "utf8"));
    expect(committed).toEqual(configSchema());
  });

  test("SARIF output has rules, regions and fixes", () => {
    const dir = project({ "src/a.ts": CODE });
    const sarif = JSON.parse(cli(["--format", "sarif"], undefined, dir).out);
    const run = sarif.runs[0];
    expect(run.columnKind).toBe("utf16CodeUnits");
    const result = run.results.find((x: { ruleId: string }) => x.ruleId === "filter-first");
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe("filter-first");
    expect(result.locations[0].physicalLocation).toMatchObject({
      artifactLocation: { uri: "src/a.ts", uriBaseId: "%SRCROOT%" }, region: { startLine: 2, startColumn: 11 },
    });
    expect(result.fixes[0].artifactChanges[0].replacements[0].insertedContent.text).toBe("xs.find((x) => x > 1)");
  });
});

describe("config", () => {
  const SRC = { "src/a.ts": CODE, "test/a.test.ts": CODE };
  const rules = (dir: string, args: string[] = []) =>
    JSON.parse(cli(["--format", "json", ...args], undefined, dir).out).findings.map((f: { file: string; rule: string }) =>
      `${path.relative(dir, f.file)}:${f.rule}`);

  test("found by searching upward, with groups, overrides and files.ignore", () => {
    const dir = project({
      ...SRC, "gen/b.ts": CODE,
      "optilint.json": JSON.stringify({
        files: { ignore: ["gen"] },
        rules: { misc: "off" },
        overrides: [{ include: ["test/**"], rules: { "filter-first": "off" } }],
      }),
    });
    expect(rules(dir)).toEqual(["src/a.ts:filter-first"]);
    expect(rules(path.join(dir, "src"))).toEqual(["a.ts:filter-first"]);
  });

  test("package.json key, extends, and levels", () => {
    const dir = project({
      ...SRC,
      "base.json": JSON.stringify({ rules: { arrays: { "filter-first": "info" } } }),
      "package.json": JSON.stringify({ name: "x", optilint: { extends: ["./base.json"], files: { include: ["src/**"] } } }),
    });
    const out = JSON.parse(cli(["--format", "json"], undefined, dir).out).findings;
    expect(out.map((f: { rule: string; severity?: string }) => [f.rule, f.severity])).toEqual([["filter-first", "info"], ["date-now", undefined]]);
  });

  test("a rule tier can only raise, and none drops the fix", () => {
    const dir = project({ ...SRC, "optilint.json": JSON.stringify({ rules: { "date-now": { level: "on", tier: "assumed" }, "filter-first": { level: "on", tier: "none" } } }) });
    const out = JSON.parse(cli(["--format", "json", "src"], undefined, dir).out).findings;
    expect(out.map((f: { fix: { tier: string } | null }) => f.fix?.tier ?? null)).toEqual([null, "assumed"]);
    cli(["--fix", "src"], undefined, dir);
    expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe(CODE);
  });

  test("the recommended preset leaves some rules out; all brings them in", () => {
    const code = "declare const x: number;\nexport const a = Math.floor(x);\n";
    expect(rules(project({ "a.ts": code }))).toEqual([]);
    expect(rules(project({ "a.ts": code, "optilint.json": '{ "rules": { "preset": "all" } }' }))).toEqual(["a.ts:bitwise-trunc"]);
  });

  test("invalid config is a usage error naming the path", () => {
    const dir = project({ ...SRC, "optilint.json": JSON.stringify({ tier: "typd", rules: { arrays: { "date-now": "off" }, "filter-frist": "off" } }) });
    const r = cli([], undefined, dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('tier: expected one of "exact", "typed", "assumed", got "typd" (did you mean "typed"?)');
    expect(r.err).toContain('rules.arrays.date-now: rule is in group "misc", not "arrays"');
    expect(r.err).toContain('rules.filter-frist: unknown rule or group (did you mean "filter-first"?)');
  });

  test("stdin of a file the config leaves out gets no findings", () => {
    const dir = project({ "optilint.json": JSON.stringify({ files: { ignore: ["gen/**"] } }) });
    const r = cli(["--stdin-filename", "gen/x.ts", "--format", "json"], CODE, dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).findings).toEqual([]);
  });
});
