import { type Case, numbers, SIZES } from "../case.ts";

const sum = (term: string) => `export function run(xs: number[]) { let n = 0; for (const x of xs) n += ${term}; return n; }`;

export const cases: Case[] = [
  { rule: "date-now", sizes: SIZES, inputs: numbers, code: sum(`(new Date().getTime() > x ? 1 : 0)`) },
  { rule: "math-pow-to-mul", sizes: SIZES, inputs: numbers, code: sum(`Math.pow(x, 2)`) },
  // Inputs are small non-negative integers, the range the assumed fix needs.
  { rule: "bitwise-trunc", sizes: SIZES, inputs: numbers, code: sum(`Math.floor(x / 3)`) },
];
