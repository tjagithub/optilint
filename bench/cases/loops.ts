import { type Case, numbers, SIZES } from "../case.ts";

export const cases: Case[] = [
  {
    rule: "foreach-to-for", sizes: SIZES, inputs: numbers,
    code: `export function run(xs: number[]) { let n = 0; xs.forEach((x) => { n += x; }); return n; }`,
  },
  {
    rule: "for-of-to-indexed", sizes: SIZES, inputs: numbers,
    code: `export function run(xs: number[]) { let n = 0; for (const x of xs) n += x; return n; }`,
  },
  {
    rule: "for-in-array", sizes: SIZES, inputs: numbers,
    code: `export function run(xs: number[]) { let n = 0; for (const i in xs) n += xs[i]!; return n; }`,
  },
  {
    rule: "cache-array-length", sizes: SIZES, inputs: numbers,
    code: `export function run(xs: number[]) { let n = 0; for (let i = 0; i < xs.length; i++) n += xs[i]!; return n; }`,
  },
];
