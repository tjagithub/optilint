import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { layer, run, UsageError } from "../src/runner.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-profile-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Line 3 (0-based 2): `function hot(` puts its `(` at column 12; `cold` is an arrow whose `(` is at column 20.
const APP = `declare function load(): string[];
const names = load();
function hot(ys: string[]) {
  let n = 0;
  for (const y of ys) if (names.includes(y)) n++;
  return n;
}
export const cold = (ys: string[]) => ys.filter((y) => y.length > 2).map((y) => y.trim());
export { hot };
`;

interface N { id: number; callFrame: object; children: number[]; kids: N[] }
let next = 1;
/** A profile node; `children` are nodes made with this too. */
const node = (functionName: string, url: string, lineNumber: number, columnNumber: number, children: N[] = []): N =>
  ({ id: next++, callFrame: { functionName, url, lineNumber, columnNumber, scriptId: "1" }, children: children.map((c) => c.id), kids: children });
const flatten = (n: N): N[] => [n, ...n.kids.flatMap(flatten)];

/** Writes a .cpuprofile where each [node, ms] pair is that many 1 ms samples. */
function profile(name: string, rootNode: N, samples: [N, number][]) {
  const ids = samples.flatMap(([n, count]) => Array<number>(count).fill(n.id));
  const nodes = flatten(rootNode).map(({ kids: _, ...n }) => n);
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify({ nodes, startTime: 0, endTime: ids.length * 1000, samples: ids, timeDeltas: ids.map(() => 1000) }));
  return file;
}

function setup(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
}

const lint = (cwd: string, paths: string[], profiles: string[], minImpact?: string) =>
  run({ cwd, paths, fix: false, profiles, layer: layer({ only: ["lookup-in-loop", "chained-array-methods"], minImpact }) }).results.flatMap((r) => r.findings);

describe("--profile", () => {
  const dir = path.join(root, "direct");
  setup(dir, { "app.ts": APP });
  const url = pathToFileURL(path.join(dir, "app.ts")).href;
  const includes = node("includes", "", -1, -1);
  const hot = node("hot", url, 2, 12, [includes]);
  const top = node("", url, 0, 0, [hot]);
  const idle = node("(idle)", "", -1, -1);
  const gc = node("(garbage collector)", "", -1, -1);
  const prof = profile("direct.cpuprofile", node("(root)", "", -1, -1, [top, idle, gc]), [[hot, 30], [includes, 50], [top, 10], [gc, 10], [idle, 400]]);

  test("charges builtins to the linted caller, leaves idle time out, and marks unseen code cold", () => {
    const found = lint(dir, ["."], [prof]);
    expect(found.map((f) => [f.rule, f.cpu, f.impact])).toEqual([
      ["lookup-in-loop", 0.8, "high"],
      ["chained-array-methods", 0, "low"],
    ]);
  });

  test("minImpact then hides what never ran", () => {
    expect(lint(dir, ["."], [prof], "medium").map((f) => f.rule)).toEqual(["lookup-in-loop"]);
  });

  test("a bad profile is a usage error", () => {
    const bad = path.join(root, "bad.cpuprofile");
    fs.writeFileSync(bad, `{"nodes": 1}`);
    expect(() => lint(dir, ["."], [bad])).toThrow(UsageError);
    expect(() => lint(dir, ["."], [path.join(root, "missing.cpuprofile")])).toThrow(/invalid --profile/);
  });
});

test("--profile reads top-level code from V8 (0:0) and Bun (`(module)` at its first statement)", () => {
  const dir = path.join(root, "toplevel");
  setup(dir, { "app.ts": "declare function load(): string[];\nexport const out = load().map((s) => s.trim()).filter(Boolean).join();\n" });
  const url = pathToFileURL(path.join(dir, "app.ts")).href;
  for (const [name, line] of [["", 0], ["(module)", 1]] as const) {
    const top = node(name, url, line, 0);
    const prof = profile(`top${line}.cpuprofile`, node("(root)", "", -1, -1, [top]), [[top, 5]]);
    expect(lint(dir, ["."], [prof]).map((f) => f.cpu)).toEqual([1]);
  }
});

test("--profile maps compiled code back through its source map", () => {
  const dir = path.join(root, "mapped");
  const out = ts.transpileModule(APP, { fileName: "app.ts", compilerOptions: { sourceMap: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const map = JSON.parse(out.sourceMapText!);
  map.sources = ["../src/app.ts"];
  setup(dir, { "src/app.ts": APP, "dist/app.js": out.outputText.replace(/\/\/# sourceMappingURL=.*/, "//# sourceMappingURL=app.js.map"), "dist/app.js.map": JSON.stringify(map) });
  // The generated `function hot(` keeps its own line; find its `(` there.
  const js = out.outputText.split("\n");
  const line = js.findIndex((l) => l.startsWith("function hot("));
  const hot = node("hot", pathToFileURL(path.join(dir, "dist", "app.js")).href, line, js[line]!.indexOf("("));
  const prof = profile("mapped.cpuprofile", node("(root)", "", -1, -1, [hot]), [[hot, 10]]);
  const found = lint(dir, ["src"], [prof]);
  expect(found.find((f) => f.rule === "lookup-in-loop")?.cpu).toBe(1);
});

const nodeBin = Bun.which("node");
test.skipIf(!nodeBin)("--profile ranks a real node --cpu-prof run hottest first", () => {
  const dir = path.join(root, "real");
  setup(dir, {
    "app.ts": `const names = Array.from({ length: 3000 }, (_, i) => "n" + i);
function busy(ys: string[]) { let n = 0; for (let r = 0; r < 200; r++) for (const y of ys) if (names.includes(y)) n++; return n; }
function idle(ys: string[]) { let n = 0; for (const y of ys) if (names.indexOf(y) > 0) n++; return n; }
console.log(busy(names.slice(2000, 2300)), idle(["n1"]));
`,
  });
  const r = spawnSync(nodeBin!, ["--cpu-prof", "--cpu-prof-interval", "100", "--cpu-prof-dir", path.join(dir, "prof"), "app.ts"], { cwd: dir, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const prof = fs.readdirSync(path.join(dir, "prof")).map((f) => path.join(dir, "prof", f));
  const found = lint(dir, ["app.ts"], prof);
  // Node's startup takes most of a short run, so only the order and the gap are certain.
  expect(found.map((f) => f.line)).toEqual([2, 3]);
  expect(found[0]!.cpu!).toBeGreaterThan(found[1]!.cpu! * 5);
});
