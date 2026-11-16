// Times one job on the engine and tier it is started with. Runs on node and bun: no Bun APIs.
// Usage: child.ts MANIFEST INDEX MS ROUNDS → prints [{ size, before, after, spread }] (ns per call).
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { do_not_optimize, measure } from "mitata";
import type { Case } from "./case.ts";
import type { Job } from "./gen.ts";

type Fn = (input: unknown) => unknown;
const [manifest, index, ms, rounds] = process.argv.slice(2);
const job = (JSON.parse(fs.readFileSync(manifest!, "utf8")) as Job[])[Number(index)]!;
const c = ((await import(job.caseUrl)) as { cases: Case[] }).cases[job.index];
const found = c && (c.name ? `${c.rule}:${c.name}` : c.rule);
if (!c || found !== job.id) throw new Error(`${job.id}: case ${job.index} of ${job.caseUrl} is ${found}`);
const before = ((await import(job.before)) as { run: Fn }).run;
const after = ((await import(job.after)) as { run: Fn }).run;
// mitata batches calls under batch_threshold ns into samples of batch_samples calls, and takes 12 samples at
// least; its defaults (65 µs, 4096) turn a 50 µs call into 2.5 s per measurement. These keep each near `ms`.
const opts = { min_cpu_time: Number(ms) * 1e6, batch_threshold: 5_000, batch_samples: 256 };

const results = [];
for (const size of job.sizes) {
  const inputs = c.inputs(size);
  for (const x of inputs) {
    if (!isDeepStrictEqual(before(x), after(x))) throw new Error(`${job.id} at size ${size}: the fix changed the result`);
  }
  const time = async (f: Fn) => (await measure(() => { for (const x of inputs) do_not_optimize(f(x)); }, opts)).p50 / inputs.length;
  // Rounds alternate which side goes first, so drift (heat, GC, other load) hits both alike.
  // `spread` is the largest / smallest per-round ratio; a high one means the machine was not steady.
  const b: number[] = [], a: number[] = [];
  for (let r = 0; r < Number(rounds); r++) {
    if (r % 2) { a.push(await time(after)); b.push(await time(before)); }
    else { b.push(await time(before)); a.push(await time(after)); }
  }
  const per = b.map((t, r) => t / a[r]!);
  results.push({ size, before: Math.min(...b), after: Math.min(...a), spread: Math.max(...per) / Math.min(...per) });
}
console.log(JSON.stringify(results));
