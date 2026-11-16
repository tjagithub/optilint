import { type Case, items, numbers, SIZES, sets, words } from "../case.ts";

const bytes = (size: number) => numbers(size).map((xs) => Uint8Array.from(xs, (x) => x & 0xff));

export const cases: Case[] = [
  {
    // A search over the second half: the copy is what the fix saves.
    rule: "typed-array-subarray", sizes: SIZES, inputs: bytes,
    code: `export function run(xs: Uint8Array) { return xs.slice(xs.length >> 1).indexOf(255); }`,
  },
  {
    rule: "array-literal-lookup", sizes: SIZES, inputs: words,
    code: `export function run(xs: string[]) {
  let n = 0;
  for (const s of xs) if (["alpha", "beta", "gamma", "delta"].includes(s)) n++;
  return n;
}`,
  },
  {
    // The match sits 90% of the way in, so find still stops before the end.
    rule: "filter-first", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return xs.filter((x) => x.n * 10 >= xs.length * 9)[0]; }`,
  },
  {
    // No match: both scan everything, and only the allocation differs.
    rule: "filter-length-to-some", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return xs.filter((x) => x.n < 0).length > 0; }`,
  },
  {
    rule: "map-flat-to-flatmap", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return xs.map((x) => x.tags).flat(); }`,
  },
  {
    rule: "unused-map", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { const out: string[] = []; xs.map((x) => { out.push(x.name); }); return out; }`,
  },
  {
    rule: "array-from-map", sizes: SIZES, inputs: sets,
    code: `export function run(xs: Set<number>) { return Array.from(xs).map((x) => x * 2); }`,
  },
  {
    rule: "redundant-array-copy", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return [...xs].map((x) => x.n); }`,
  },
];
