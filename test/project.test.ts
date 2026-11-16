import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/runner.ts";

// `xs` is declared only in each package's globals.d.ts, so a typed fix proves that package's tsconfig was used.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-project-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function pkg(dir: string, tsconfig: object) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  fs.writeFileSync(path.join(dir, "globals.d.ts"), "declare const xs: number[];\n");
  fs.writeFileSync(path.join(dir, "a.ts"), "xs.forEach((x) => console.log(x));\nexport {};\n");
}

const tierOf = (cwd: string, paths: string[], project?: string) => {
  const { results } = run({ cwd, paths, fix: false, layer: { only: ["foreach-to-for"], maxSlowdown: Infinity }, project });
  return results.flatMap((r) => r.findings.map((f) => f.fix?.tier));
};

test("a solution-style tsconfig resolves to the referenced project that lists the file", () => {
  const mono = path.join(root, "mono");
  pkg(path.join(mono, "packages", "app"), { compilerOptions: { composite: true }, include: ["*.ts"] });
  fs.writeFileSync(path.join(mono, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "packages/app" }] }));
  expect(tierOf(mono, ["packages/app/a.ts"])).toEqual(["typed"]);
  expect(tierOf(mono, ["packages/app/a.ts"], "tsconfig.json")).toEqual(["typed"]);
});

test("the tsconfig is looked up from each linted file, not from the cwd", () => {
  const ws = path.join(root, "ws");
  pkg(path.join(ws, "one"), { include: ["*.ts"] });
  pkg(path.join(ws, "two"), { include: ["*.ts"] });
  expect(tierOf(ws, ["one/a.ts", "two/a.ts"])).toEqual(["typed", "typed"]);
});
