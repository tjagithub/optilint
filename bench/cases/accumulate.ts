import { type Case, items } from "../case.ts";

// Quadratic before the fix: 100 items already shows it, 1000 only makes the run slow.
const SIZES = [10, 100];

export const cases: Case[] = [
  {
    rule: "spread-in-accumulator", name: "array", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return xs.reduce((acc, x) => [...acc, x.n * 2], [] as number[]); }`,
  },
  {
    rule: "spread-in-accumulator", name: "object", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return xs.reduce((acc, x) => ({ ...acc, [x.name]: x.n }), {} as Record<string, number>); }`,
  },
  {
    rule: "accumulate-by-copy-in-loop", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { let out: number[] = []; for (const x of xs) out = [...out, x.n]; return out; }`,
  },
];
