import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { generate, loadCases, SKIPPED } from "../bench/gen.ts";
import { allRules, retiredRules } from "../src/rules/index.ts";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-bench-test-"));
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));
const loaded = await loadCases();

test("every fixable rule has a bench case or a reason it has none", () => {
  const benched = new Set(loaded.flatMap(({ cases }) => cases.map((c) => c.rule)));
  const fixable = [...allRules, ...retiredRules].filter((r) => r.tiers.length > 0).map((r) => r.name);
  expect(fixable.filter((r) => !benched.has(r) && !(r in SKIPPED))).toEqual([]);
  expect(Object.keys(SKIPPED).filter((r) => !fixable.includes(r) || benched.has(r))).toEqual([]);
});

// generate() throws when a case no longer triggers its rule's fix.
const jobs = loaded.flatMap(({ file, cases }) => generate(file, cases, outDir).map((job) => ({ job, c: cases[job.index]! })));

test.each(jobs.map(({ job, c }) => [job.id, job, c] as const))("%s: the fix keeps every result", async (_, job, c) => {
  type Fn = (x: unknown) => unknown;
  // Load the case as child.ts does, through the job's URL.
  expect(((await import(job.caseUrl)) as { cases: unknown[] }).cases[job.index]).toBe(c);
  const before = ((await import(job.before)) as { run: Fn }).run;
  const after = ((await import(job.after)) as { run: Fn }).run;
  for (const size of c.sizes) for (const x of c.inputs(size)) expect(after(x)).toEqual(before(x));
});

/** The input with holes at 1 and 3, or undefined when it is not an array. */
function holey(x: unknown) {
  if (!Array.isArray(x) || x.length < 4) return;
  const h = x.slice();
  // optilint-disable-next-line delete-property
  delete h[1], delete h[3];
  return h;
}
const outcome = (f: (x: unknown) => unknown, x: unknown) => {
  try {
    return { value: f(x) };
  } catch (e) {
    return { threw: (e as Error).constructor.name };
  }
};

// A typed fix may take element values to match their type, as TypeScript does (`xs[i]: T`),
// but must not change which elements are visited: holes are legal in every array type.
const READS_HOLES_TOO: Record<string, string> = {
  "bitwise-trunc": "the original loop reads the holes too, as undefined, which number[] excludes",
  "regex-to-string-method": "the original loop reads the holes too, as undefined, which string[] excludes",
  "match-to-test": "the original loop reads the holes too, as undefined, which string[] excludes",
  "for-in-array": "an assumed fix that states the array has no holes",
  "filter-first": "assumed unless the array provably has no holes (bench cases fix at assumed)",
  "redundant-array-copy": "assumed unless the array provably has no holes (bench cases fix at assumed)",
};
const holeJobs = jobs.filter(({ c }) => !(c.rule in READS_HOLES_TOO));
test.each(holeJobs.map(({ job, c }) => [job.id, job, c] as const))("%s: the fix keeps every result on arrays with holes", async (_, job, c) => {
  type Fn = (x: unknown) => unknown;
  const before = ((await import(job.before)) as { run: Fn }).run;
  const after = ((await import(job.after)) as { run: Fn }).run;
  for (const x of c.inputs(c.sizes[0]!).map(holey).filter((h) => h !== undefined)) {
    const want = outcome(before, x), got = outcome(after, x);
    expect(isDeepStrictEqual(got, want) ? want : got).toEqual(want);
  }
});
