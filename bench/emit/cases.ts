// TS-only syntax whose emit might cost at run time (`bun run bench:emit`). Each variant is TS plus the options it is
// emitted with; the first variant of a case is the baseline the others are timed against.
import ts from "typescript";

export interface Variant { label: string; code: string; options: ts.CompilerOptions }
export interface EmitCase { id: string; inputs: keyof typeof import("./child.ts").INPUTS; sizes: number[]; variants: Variant[] }

const T = ts.ScriptTarget;
const at = (target: ts.ScriptTarget, extra: ts.CompilerOptions = {}): ts.CompilerOptions => ({ target, module: ts.ModuleKind.ESNext, ...extra });

const awaitLoop = `async function step(x: number) { return x + 1; }
export async function run(xs: number[]) { let n = 0; for (const x of xs) n += await step(x); return n; }`;
const awaitValues = `export async function run(xs: number[]) { let n = 0; for (const x of xs) n += await x; return n; }`;
const cached = `const cache = new Map<number, number>();
async function get(k: number) { const v = cache.get(k); if (v !== undefined) return v; cache.set(k, k * 2); return k * 2; }
export async function run(xs: number[]) { let n = 0; for (const x of xs) n += await get(x % 50); return n; }`;

const sw = (a: string, b: string, c: string) => `export function run(xs: { kind: any; v: number }[]) {
  let n = 0;
  for (const x of xs) {
    switch (x.kind) { case ${a}: n += x.v; break; case ${b}: n -= x.v; break; case ${c}: n ^= x.v; break; default: n++; }
  }
  return n;
}`;

const geo = (ns: boolean) => `interface P { x: number; y: number }
${ns ? "namespace Geo {\n  export const SCALE = 2;\n  export function dist(a: P, b: P) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }\n}" : "const SCALE = 2;\nfunction dist(a: P, b: P) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }"}
export function run(ps: P[]) { let n = 0; for (let i = 1; i < ps.length; i++) n += ${ns ? "Geo.dist" : "dist"}(ps[i - 1]!, ps[i]!) * ${ns ? "Geo.SCALE" : "SCALE"}; return n; }`;

const fields = `class P { x = 0; y = 0; z = 0; tag = ""; on = false; constructor(x: number) { this.x = x; } }
export function run(xs: number[]) { const out: P[] = []; for (const x of xs) out.push(new P(x)); return out; }`;

const privates = `class Counter { #n = 0; #step: number; constructor(step: number) { this.#step = step; } add() { this.#n += this.#step; return this.#n; } }
export function run(xs: number[]) { let t = 0; for (const x of xs) { const c = new Counter(x); c.add(); t += c.add(); } return t; }`;

export const CASES: EmitCase[] = [
  {
    id: "private-fields", inputs: "numbers", sizes: [10, 1000],
    variants: [{ label: "es2022 (#native)", code: privates, options: at(T.ES2022) }, { label: "es2021 (WeakMap)", code: privates, options: at(T.ES2021) }],
  },
  {
    id: "async-await-call", inputs: "numbers", sizes: [10, 1000],
    variants: [{ label: "es2022", code: awaitLoop, options: at(T.ES2022) }, { label: "es2015 (__awaiter)", code: awaitLoop, options: at(T.ES2015) }],
  },
  {
    id: "async-await-value", inputs: "numbers", sizes: [10, 1000],
    variants: [{ label: "es2022", code: awaitValues, options: at(T.ES2022) }, { label: "es2015 (__awaiter)", code: awaitValues, options: at(T.ES2015) }],
  },
  {
    id: "async-cached", inputs: "numbers", sizes: [10, 1000],
    variants: [{ label: "es2022", code: cached, options: at(T.ES2022) }, { label: "es2015 (__awaiter)", code: cached, options: at(T.ES2015) }],
  },
  {
    id: "enum-numeric", inputs: "kinds", sizes: [10, 1000],
    variants: [
      { label: "literals", code: sw("0", "1", "2"), options: at(T.ES2022) },
      { label: "enum", code: `enum Kind { A, B, C, D }\n${sw("Kind.A", "Kind.B", "Kind.C")}`, options: at(T.ES2022) },
      { label: "as const", code: `const Kind = { A: 0, B: 1, C: 2, D: 3 } as const;\n${sw("Kind.A", "Kind.B", "Kind.C")}`, options: at(T.ES2022) },
    ],
  },
  {
    id: "enum-string", inputs: "colors", sizes: [10, 1000],
    variants: [
      { label: "literals", code: sw(`"red"`, `"green"`, `"blue"`), options: at(T.ES2022) },
      { label: "enum", code: `enum Color { Red = "red", Green = "green", Blue = "blue" }\n${sw("Color.Red", "Color.Green", "Color.Blue")}`, options: at(T.ES2022) },
    ],
  },
  {
    id: "namespace", inputs: "points", sizes: [10, 1000],
    variants: [{ label: "module", code: geo(false), options: at(T.ES2022) }, { label: "namespace", code: geo(true), options: at(T.ES2022) }],
  },
  {
    id: "class-fields", inputs: "numbers", sizes: [10, 1000],
    variants: [
      { label: "es2022 define (native)", code: fields, options: at(T.ES2022) },
      { label: "es2022 assign", code: fields, options: at(T.ES2022, { useDefineForClassFields: false }) },
      { label: "es2020 define (defineProperty)", code: fields, options: at(T.ES2020, { useDefineForClassFields: true }) },
      { label: "es2020 assign", code: fields, options: at(T.ES2020) },
    ],
  },
];
