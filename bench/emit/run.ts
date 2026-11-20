// Emits each case's variants with TypeScript and times them on engine tiers: the first variant's time ÷ each other's.
// Usage: bun bench/emit/run.ts [--tiers peak|all|LIST] [case,...]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { selectTiers } from "../tiers.ts";
import { CASES } from "./cases.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--tiers");
const tiers = selectTiers(at >= 0 ? args.splice(at, 2)[1] ?? "all" : "all");
const wanted = args[0]?.split(",");
const cases = CASES.filter((c) => !wanted || wanted.includes(c.id));
const child = path.join(import.meta.dirname, "child.ts");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-emit-"));
const urls = new Map(cases.map((c) => [c.id, c.variants.map((v, i) => {
  const file = path.join(out, `${c.id}.${i}.mjs`);
  fs.writeFileSync(file, ts.transpileModule(v.code, { compilerOptions: v.options }).outputText);
  return pathToFileURL(file).href;
})]));

const rows: string[] = [];
for (const tier of tiers) {
  for (const c of cases) {
    const cells = c.sizes.map((size) => {
      const r = spawnSync(tier.cmd, [...(tier.args ?? []), child, c.inputs, String(size), "150", "5", ...urls.get(c.id)!],
        { env: { ...process.env, ...tier.env }, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${tier.id} ${c.id}: ${r.stderr.trim().split("\n").at(-1)}`);
      return JSON.parse(r.stdout) as number[];
    });
    for (const [i, v] of c.variants.entries()) {
      if (i === 0) continue;
      const ratios = cells.map((ns) => `${(ns[0]! / ns[i]!).toFixed(2)}x`.padStart(7));
      rows.push(`${tier.id.padEnd(14)} ${c.id.padEnd(18)} ${`${c.variants[0]!.label} ÷ ${v.label}`.padEnd(48)} ${ratios.join(" ")}`);
    }
    process.stderr.write(".");
  }
}
fs.rmSync(out, { recursive: true, force: true });
const sizes = cases[0]?.sizes ?? [];
console.log(`\n${"tier".padEnd(14)} ${"case".padEnd(18)} ${"ratio (under 1: the right side is slower)".padEnd(48)} ${sizes.map((s) => `@${s}`.padStart(7)).join(" ")}`);
console.log(rows.join("\n"));
