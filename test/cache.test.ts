import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/runner.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-cache-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A fresh project dir with `files`, and a linter that reports foreach-to-for tiers per file through the cache. */
function project(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const write = (f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
  for (const [f, text] of Object.entries(files)) write(f, text);
  const lint = () => {
    const r = run({ cwd: dir, paths: ["."], fix: false, layer: { only: ["foreach-to-for"], maxSlowdown: Infinity }, cache: "cache.json" });
    const tiers = Object.fromEntries(r.results.map((x) => [path.basename(x.file), x.findings.map((f) => f.fix?.tier ?? "none")]));
    return { tiers, cached: r.cached };
  };
  return { write, lint };
}

const USE = (from: string) => `import { xs } from "${from}";\nxs.forEach((x) => console.log(x));\n`;

test("an unchanged rerun reuses every file's findings", () => {
  const p = project("same", { "lib.ts": "export const xs: number[] = [];\n", "use.ts": USE("./lib") });
  const first = p.lint();
  expect(first).toEqual({ tiers: { "lib.ts": [], "use.ts": ["typed"] }, cached: 0 });
  expect(p.lint()).toEqual({ ...first, cached: 2 });
});

test("a change to an imported type re-lints the file that imports it", () => {
  const p = project("imported", { "lib.ts": "export const xs: number[] = [];\n", "use.ts": USE("./lib") });
  p.lint();
  p.write("lib.ts", "export const xs: any = [];\n");
  expect(p.lint()).toEqual({ tiers: { "lib.ts": [], "use.ts": ["assumed"] }, cached: 0 });
});

test("a global script counts for every file, and a partial run still sees it", () => {
  const p = project("global", { "g.ts": "declare const ys: number[];\n", "b.ts": "ys.forEach((y) => console.log(y));\nexport {};\n" });
  p.lint();
  p.write("b.ts", "ys.forEach((y) => console.log(y));\nexport const n = 1;\n");
  expect(p.lint()).toEqual({ tiers: { "b.ts": ["typed"], "g.ts": [] }, cached: 1 });
  p.write("g.ts", "declare const ys: any;\n");
  expect(p.lint()).toEqual({ tiers: { "b.ts": ["assumed"], "g.ts": [] }, cached: 0 });
});

test("an import that starts to resolve re-lints the importer", () => {
  const p = project("missing", { "use.ts": USE("./later") });
  expect(p.lint().tiers["use.ts"]).toEqual(["assumed"]);
  p.write("later.ts", "export const xs: number[] = [];\n");
  expect(p.lint()).toEqual({ tiers: { "later.ts": [], "use.ts": ["typed"] }, cached: 0 });
});

test("files in an import cycle share a key, and a change anywhere in it re-lints them", () => {
  const p = project("cycle", {
    "a.ts": `import "./b";\n${USE("./c")}`, "b.ts": "import \"./a\";\nexport {};\n", "c.ts": "export const xs: number[] = [];\n",
  });
  p.lint();
  p.write("b.ts", "import \"./a\";\nexport const b = 1;\n");
  expect(p.lint()).toEqual({ tiers: { "a.ts": ["typed"], "b.ts": [], "c.ts": [] }, cached: 1 });
});

test("fix runs ignore the cache", () => {
  const p = project("fix", { "use.ts": "declare const xs: number[];\nxs.forEach((x) => console.log(x));\nexport {};\n" });
  p.lint();
  const dir = path.join(root, "fix");
  const r = run({ cwd: dir, paths: ["."], fix: true, layer: { only: ["foreach-to-for"], maxSlowdown: Infinity }, cache: "cache.json" });
  expect(r.cached).toBe(0);
  expect(r.results[0]!.output).not.toContain("forEach");
});
