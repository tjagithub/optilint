// Times each emitted variant of one case on the engine and tier it is started with. Runs on node and bun: no Bun APIs.
// Usage: child.ts INPUT SIZE MS ROUNDS URL... → prints the best p50 (ns per call) of each URL's `run`.
import { do_not_optimize, measure } from "mitata";

type Fn = (input: unknown) => unknown;
const variants = <T>(make: (v: number) => T) => Array.from({ length: 8 }, (_, v) => make(v));
const range = <T>(size: number, make: (j: number) => T) => Array.from({ length: size }, (_, j) => make(j));
const COLORS = ["red", "green", "blue", "other"];

/** 8 variants per size, so no call site sees one constant input. */
export const INPUTS = {
  numbers: (size: number) => variants((v) => range(size, (j) => j + v)),
  kinds: (size: number) => variants((v) => range(size, (j) => ({ kind: (j * 7 + v) % 4, v: j }))),
  colors: (size: number) => variants((v) => range(size, (j) => ({ kind: COLORS[(j * 7 + v) % 4], v: j }))),
  points: (size: number) => variants((v) => range(size, (j) => ({ x: (j * 13 + v) % 97, y: (j * 7) % 31 }))),
};

if (process.argv.length > 2) {
  const [input, size, ms, rounds, ...urls] = process.argv.slice(2);
  const xs = INPUTS[input as keyof typeof INPUTS](Number(size));
  const fns = await Promise.all(urls.map(async (u) => ((await import(u)) as { run: Fn }).run));
  // Class instances differ by prototype between variants, so results compare as JSON.
  const out = async (f: Fn, x: unknown) => JSON.stringify(await f(x));
  for (const x of xs) {
    const want = await out(fns[0]!, x);
    for (const [i, f] of fns.entries()) if ((await out(f, x)) !== want) throw new Error(`${urls[i]} gives another result`);
  }
  const isAsync = fns[0]!(xs[0]) instanceof Promise;
  const opts = { min_cpu_time: Number(ms) * 1e6, batch_threshold: 5_000, batch_samples: 256 };
  const time = async (f: Fn) => (await measure(isAsync
    ? async () => { for (const x of xs) do_not_optimize(await f(x)); }
    : () => { for (const x of xs) do_not_optimize(f(x)); }, opts)).p50 / xs.length;

  const best = fns.map(() => Infinity);
  for (let r = 0; r < Number(rounds); r++) {
    // Each round rotates which variant goes first, so drift hits all alike; the timings must not overlap.
    for (let k = 0; k < fns.length; k++) {
      const i = (k + r) % fns.length;
      // optilint-disable-next-line await-in-loop
      best[i] = Math.min(best[i]!, await time(fns[i]!));
    }
  }
  console.log(JSON.stringify(best));
}
