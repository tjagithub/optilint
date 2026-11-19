/** One rule's "before" code; `gen.ts` runs optilint's fixer on it to get the "after" code. */
export interface Case {
  rule: string;
  /** Tells several cases of one rule apart. */
  name?: string;
  /** TypeScript declaring `export function run(input)`, written the way the rule finds it. `Item` is in scope. */
  code: string;
  sizes: readonly number[];
  /** A few variants per size, so no call site sees one constant input. Never mutated. */
  inputs: (size: number) => unknown[];
  /** Why the case is outside what the fix promises: measured for FINDINGS.md, left out of `src/speedups.ts`. */
  outOfScope?: string;
}

export const SIZES = [10, 1000] as const;
export const PRELUDE = "interface Item { name: string; n: number; on: boolean; tags: string[] }\n";

export interface Item { name: string; n: number; on: boolean; tags: string[] }

const variants = <T>(make: (v: number) => T) => Array.from({ length: 8 }, (_, v) => make(v));
const range = <T>(size: number, make: (j: number) => T) => Array.from({ length: size }, (_, j) => make(j));

export const numbers = (size: number) => variants((v) => range(size, (j) => j + v));
export const items = (size: number) =>
  variants((v) => range(size, (j): Item => ({ name: `item${j}_${v}`, n: j, on: (j + v) % 3 !== 0, tags: [`t${j % 5}`, `v${v}`] })));
/** Functions that each capture their own value, as callbacks and handlers do. */
export const closures = (size: number) => variants((v) => range(size, (j) => () => j + v));
/** Arrays behind pass-through `get` and `has` traps, as reactive libraries wrap them. */
export const proxied = (size: number) =>
  numbers(size).map((xs) => new Proxy(xs, { get: (t, k, r) => Reflect.get(t, k, r), has: (t, k) => Reflect.has(t, k) }));
export const sets = (size: number) => numbers(size).map((xs) => new Set(xs));
export const records = (size: number) => variants((v) => Object.fromEntries(range(size, (j) => [`key${j}_${v}`, j])));
export const words = (size: number) =>
  variants((v) => range(size, (j) => ["alpha", "omega", "beta", "zeta", "gamma", "delta"][(j + v) % 6]!));
/** Strings that mostly miss, as most checks in real code do; every 10th hits. */
export const lines = (size: number) =>
  variants((v) => range(size, (j) => (j % 10 === 9 ? `http://host/${j}/needle-${v}@x` : `plain line ${j} of text ${v}`)));
