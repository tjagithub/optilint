import { type Case, closures, items, numbers, proxied, SIZES } from "../case.ts";

export const cases: Case[] = [
  {
    rule: "foreach-to-for", sizes: SIZES, inputs: numbers,
    code: `export function run(xs: number[]) { let n = 0; xs.forEach((x) => { n += x; }); return n; }`,
  },
  {
    rule: "foreach-to-for", name: "objects", sizes: SIZES, inputs: items,
    code: `export function run(xs: Item[]) { let n = 0; xs.forEach((it) => { n += it.n; if (it.on) n++; }); return n; }`,
  },
  {
    rule: "foreach-to-for", name: "closures", sizes: SIZES, inputs: closures,
    code: `export function run(fs: (() => number)[]) { let n = 0; fs.forEach((f) => { n += f(); }); return n; }`,
  },
  {
    rule: "foreach-to-for", name: "proxy", sizes: SIZES, inputs: proxied,
    outOfScope: "Proxy-wrapped arrays (Vue reactive, MobX): V8 reads them faster through forEach (FINDINGS.md, 2026-11-19)",
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
