import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate, loadCases, SKIPPED } from "../bench/gen.ts";
import { allRules } from "../src/rules/index.ts";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-bench-test-"));
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));
const loaded = await loadCases();

test("every fixable rule has a bench case or a reason it has none", () => {
  const benched = new Set(loaded.flatMap(({ cases }) => cases.map((c) => c.rule)));
  const fixable = allRules.filter((r) => r.tiers.length > 0).map((r) => r.name);
  expect(fixable.filter((r) => !benched.has(r) && !(r in SKIPPED))).toEqual([]);
  expect(Object.keys(SKIPPED).filter((r) => !fixable.includes(r) || benched.has(r))).toEqual([]);
});

// generate() throws when a case no longer triggers its rule's fix.
const jobs = loaded.flatMap(({ file, cases }) => generate(file, cases, outDir).map((job) => ({ job, c: cases[job.index]! })));

test.each(jobs.map(({ job, c }) => [job.id, job, c] as const))("%s: the fix keeps every result", async (_, job, c) => {
  type Fn = (x: unknown) => unknown;
  const before = ((await import(job.before)) as { run: Fn }).run;
  const after = ((await import(job.after)) as { run: Fn }).run;
  for (const size of c.sizes) for (const x of c.inputs(size)) expect(after(x)).toEqual(before(x));
});
