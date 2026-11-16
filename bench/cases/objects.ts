import { type Case, items, records, SIZES } from "../case.ts";

export const cases: Case[] = [
  {
    rule: "object-assign-to-spread", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { return xs.map((x) => Object.assign({}, x, { on: !x.on })); }`,
  },
  {
    rule: "object-entries-iteration", sizes: SIZES, inputs: records,
    code: `export function run(o: Record<string, number>) {
  let n = 0;
  for (const [k, v] of Object.entries(o)) n += k.length + v;
  return n;
}`,
  },
];
