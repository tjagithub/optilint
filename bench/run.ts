// Before/after benches of optilint's fixes, per engine and compiler tier. See bench/README.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { generate, type Job, loadCases, UNSTEADY } from "./gen.ts";
import { selectTiers } from "./tiers.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tiers: { type: "string", default: "peak" }, time: { type: "string", default: "150" }, rounds: { type: "string", default: "3" }, json: { type: "string" }, show: { type: "boolean" } },
});
const tiers = selectTiers(values.tiers);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-bench-"));
const jobs: Job[] = [];
for (const { file, cases } of await loadCases()) {
  jobs.push(...generate(file, cases, outDir, (c) => !positionals.length || positionals.some((p) => c.rule === p || `${c.rule}:${c.name}` === p)));
}
if (!jobs.length) throw new Error(`no cases match: ${positionals.join(" ")}`);
const manifest = path.join(outDir, "jobs.json");
fs.writeFileSync(manifest, JSON.stringify(jobs));

if (values.show) for (const j of jobs) console.log(`── ${j.id}\n${j.source.before}── fixed\n${j.source.after}`);

const child = path.join(import.meta.dirname, "child.ts");
const ratios = new Map<string, Map<string, string>>(); // "id @size" → tier → ratio
interface Measured { size: number; before: number; after: number; spread: number }
const raw: ({ tier: string; id: string } & Measured)[] = [];
const took: { what: string; ms: number }[] = [];
const started = performance.now();
for (const tier of tiers) {
  process.stderr.write(`${tier.id}: `);
  for (const [i, job] of jobs.entries()) {
    const t0 = performance.now();
    const r = spawnSync(tier.cmd, [...(tier.args ?? []), child, manifest, String(i), values.time, values.rounds], { env: { ...process.env, ...tier.env }, encoding: "utf8" });
    took.push({ what: `${job.id} on ${tier.id}`, ms: performance.now() - t0 });
    process.stderr.write(".");
    // An error is a bug (a crash, or a fix that changed a result), so stop instead of timing the rest.
    if (r.status !== 0) {
      const why = r.stderr.trim().split("\n").findLast((l) => /Error/.test(l)) ?? `exit ${r.status}`;
      console.error(`\n${tier.id} ${job.id}: ${why}`);
      fs.rmSync(outDir, { recursive: true, force: true });
      process.exit(1);
    }
    for (const m of JSON.parse(r.stdout) as Measured[]) {
      raw.push({ tier: tier.id, id: job.id, ...m });
      cell(`${job.id} @${m.size}`, tier.id, `${(m.before / m.after).toFixed(2)}x${m.spread > UNSTEADY ? "?" : " "}`);
    }
  }
  process.stderr.write("\n");
}

function cell(row: string, tier: string, text: string) {
  if (!ratios.has(row)) ratios.set(row, new Map());
  ratios.get(row)!.set(tier, text);
}

const version = (cmd: string) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).stdout.trim();
const meta = { date: new Date().toISOString().slice(0, 10), node: version("node"), bun: version("bun"), cpu: os.cpus()[0]?.model, timeMs: Number(values.time), rounds: Number(values.rounds) };
console.log(`# ${meta.date} · ${meta.cpu} · Node ${meta.node} · Bun ${meta.bun} · ${meta.timeMs} ms, ${meta.rounds} rounds\n`);
const width = Math.max(...[...ratios.keys()].map((k) => k.length));
const cols = tiers.map((t) => Math.max(t.id.length, 8));
console.log(["case".padEnd(width), ...tiers.map((t, i) => t.id.padStart(cols[i]!))].join("  "));
for (const [row, byTier] of ratios) console.log([row.padEnd(width), ...tiers.map((t, i) => (byTier.get(t.id) ?? "").padStart(cols[i]!))].join("  "));
console.log(`\nbefore time / after time: above 1.00x the fix is faster. ? = rounds differ by over ${Math.round((UNSTEADY - 1) * 100)}%; re-run it.`);
const slowest = took.sort((a, b) => b.ms - a.ms).slice(0, 3).map((t) => `${t.what} ${(t.ms / 1000).toFixed(1)}s`);
console.error(`took ${((performance.now() - started) / 1000).toFixed(0)}s; slowest: ${slowest.join(", ")}`);

if (values.json) {
  fs.mkdirSync(path.dirname(path.resolve(values.json)), { recursive: true });
  fs.writeFileSync(values.json, JSON.stringify({ ...meta, results: raw }, null, 2) + "\n");
}
fs.rmSync(outDir, { recursive: true, force: true });
