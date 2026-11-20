# Bench findings

What `bench/` measured, per rule, and what to do about it. Newest run first; when an engine is upgraded, add a dated run rather than editing an old one. Proposals that act on these link here (`proposals/`).

Ratios are before time ÷ after time: above 1.00x the fix is faster. "Every tier" means all eight: V8 TurboFan, Maglev, Sparkplug, Ignition and JSC FTL, DFG, Baseline, LLInt. Causes marked *unverified* are guesses that still need a look at the engine source (`proposals/README.md`, Sources). Ranges leave out unsteady cells (`?`, spread over 1.2), as `src/speedups.ts` does.

## 2026-11-20: TypeScript emit (`bench/emit`)

Apple M4, Node v26.13.1, Bun 1.4.4, TypeScript 6.0.3; every tier, 150 ms, 5 rounds, sizes 10 and 1000 (`bun run bench:emit`, output in `results/emit-2026-11-20.txt`). Each case is one TS source emitted at two or more settings; the ratio is the faster form's time ÷ the other's, so here under 1.00x means the emitted form is slower.

- **Downlevelled `async` (target ES2015, `__awaiter` + generator): 2–14x slower** on every tier (0.07–0.50x): calling an async function 6–14x, awaiting plain values 2–7x, an async cache hit 5–10x. → `downlevel-async`.
- **Class fields as `Object.defineProperty` (`useDefineForClassFields: true`, target ES2020): 4–100x slower** to construct (0.01–0.22x; TurboFan 0.01x). Native fields and plain assignment are even at the peak tiers; at the interpreter and baseline tiers assignment is 1.09–1.24x faster than native fields. → `define-class-fields`.
- **Downlevelled `#private` (target ES2021, WeakMap helpers): 5x to over 200x slower** (0.00–0.21x; TurboFan and FTL 0.00–0.02x). → `downlevel-private-fields`.
- **`enum` is free at the top tiers, mostly.** Numeric enum vs literals: 0.92–1.06x on TurboFan and FTL; lower tiers down to 0.59x (JSC Baseline). String enum: 0.81–0.87x on TurboFan, 1.00–1.03x on FTL, 0.28–0.38x on JSC Baseline. An `as const` object costs the same as the enum (0.55–1.03x), so the cost is the property load, and only inlined literals avoid it. No rule: the faster form changes the module's API, and the gain is mostly on cold tiers.
- **`namespace` is free** (0.88–1.20x, noise both ways). No rule.

## 2026-11-19: `foreach-to-for` hole test, objects, closures and proxies

Apple M4, Node v26.13.1, Bun 1.4.4; every tier, 150 ms, 5 rounds, sizes 10, 1000 and 100 000. A one-off driver timed hand-written `forEach`, the loop with the hole test (`if (x === undefined && !(i in xs)) continue;`) and the loop without it, with `child.ts` and the inputs of the four `foreach-to-for` cases (numbers, `objects`, `closures`, `proxy`).

- **The hole test is about free.** Dropping it is 1.00–1.25x on objects and closures (LLInt and Baseline gain most, peak tiers nothing), and mixed on numbers: 1.17x on LLInt, but 0.67x on Maglev at 10 items (steady over four runs; *unverified*: the `undefined` compare may feed Maglev a type check it then uses). Both loops beat `forEach` on plain arrays everywhere (1.00–6.84x). **Decided (user, 2026-11-19):** the fix leaves the test out when the array provably has no holes, for readability.
- **Proxies lose on V8.** Over a Proxy with pass-through `get`/`has` traps, `forEach` beats the loop on V8: 0.75–0.82x on TurboFan and Maglev, 0.89–1.02x on Sparkplug and Ignition. JSC goes the other way (1.45–2.15x). *Unverified:* V8's builtin `forEach` reaches the traps from C++/Torque, while `xs[i]` in JS code goes through a generic keyed load each time. Proxied arrays are common (Vue `reactive`, MobX), but no type tells them apart, so **decided (user, 2026-11-19):** the `proxy` case is `outOfScope`: it is benched and reported here, but `src/speedups.ts` leaves it out, and `docs/rules.md` says that tiers do not cover proxies.

## 2026-11-16

Apple M4, Node v26.13.1 (V8 14.6), Bun 1.4.4 (JSC); `bun run bench --tiers all`, 150 ms per measurement, 3 rounds. Full table: [`results/2026-11-16.txt`](results/2026-11-16.txt), data: [`results/2026-11-16.json`](results/2026-11-16.json) (the second full run that day; `src/speedups.ts` comes from it). Sizes are 10 and 1000 items (10 and 100 for the quadratic accumulator cases).

**Decided (user, 2026-11-16):** a fix may be at most 10% slower than the original on any engine, tier or size; the margin allows for noise. This is the `maxSlowdown` setting (default `"10%"`), measured as after ÷ before time − 1. Off by default: `map-flat-to-flatmap` (186% slower at worst), `for-of-to-indexed` (41%), `bitwise-trunc` and `math-pow-to-mul` (34%). They stay one setting away (`maxSlowdown: "any"`). A hard 1.00x gate was tried first; it also dropped `foreach-to-for`, `match-to-test` and `filter-length-to-some`, which are within noise.

### Loses: change or drop the fix

- **`array-from-map`: slower on every tier of both engines** (0.12–0.98x). Worst on V8: TurboFan 0.12–0.15x, Maglev 0.41–0.50x; JSC 0.56–0.98x. `Array.from(set).map(f)` beats `Array.from(set, f)`. *Unverified cause:* the optimizing tiers inline `.map` and its callback, while `Array.from` calls `f` from a builtin.
  **Done:** retired (it never runs; code, tests and bench case kept).
- **`object-entries-iteration`, `[k, v]` form: V8 loses at its top tiers** (TurboFan 0.60x at 10 keys and 0.10x at 1000; Sparkplug 0.61x at 1000). JSC wins at 10 keys (FTL 7.4x, DFG 5.7x, Baseline 3.9x) but is about even at 1000 (0.86–1.48x). The case uses 8 objects with different keys, so `o[k]` in the fixed loop sees several shapes; a single-shape case may differ.
  The other two forms win on every tier of both engines: `[, v]` → `Object.values` and `[k]` → `Object.keys`, 2.18–13.71x together.
  **Done:** the `[k, v]` form is now its own rule, `object-entries-pair`, and retired; `object-entries-iteration` keeps the two exact forms. Next: bench a single-shape case to see whether `object-entries-pair` should come back as JSC-only (`engines: ["jsc"]`).

### Mixed: loses on some tiers

- **`map-flat-to-flatmap`** (0.35–2.08x): V8 even at TurboFan (1.01–1.03x) and 1.1–1.2x below it; JSC FTL 1.4–2.1x, but DFG 0.80x at 1000, Baseline 0.52x and LLInt 0.35–0.40x. So cold code on Bun or Safari gets slower.
- **`for-of-to-indexed`** (0.71–3.17x): wins on every V8 tier (1.18–3.17x) and on JSC FTL and DFG; loses on JSC Baseline (0.71x at 1000) and LLInt (0.87–0.97x). That contradicts its `why` text, which says baseline tiers pay for the iterator protocol. *Unverified cause:* JSC's bytecode has a fast path for for-of over arrays.
- **`bitwise-trunc`** (0.75–1.59x): wins everywhere except JSC Baseline (0.75–0.76x). Already obscure, assumed and not recommended.
- **`math-pow-to-mul`** (0.75–2.86x): wins on every V8 tier and on JSC Baseline and LLInt (1.85–2.86x), even on DFG (0.99–1.00x), but JSC FTL is 0.75x at 1000 (steady in both runs). *Unverified cause:* FTL already turns `Math.pow(x, 2)` into a multiply.
- **`foreach-to-for`** (0.99–4.22x): wins on every tier except V8 Ignition at 1000 items, 0.99x (spread 1.01; the first run that day had 1.00x). Within the 10% margin, so it runs; `maxSlowdown: "0%"` turns it off.

Once `targets` exists, `map-flat-to-flatmap` and `for-of-to-indexed` could run for V8-only targets, and `math-pow-to-mul` still needs a look at why FTL loses.

### Even: no real gain

- **`cache-array-length`** (1.00–1.21x): 1.00–1.01x on TurboFan, FTL and DFG at 1000; a small gain only on the lowest tiers (Sparkplug 1.17–1.21x, LLInt 1.15–1.18x). Its losses (Maglev 0.68x, FTL 0.97x and DFG 0.99x at 10) are all unsteady, so it counts as never slower. This confirms `proposals/shared.md`: not recommended, and fix the `why` text.
- **`filter-length-to-some`** (0.93–1.25x; DFG 0.93x at 1000) and **`match-to-test`** (0.97–1.27x; FTL 0.97–0.98x, LLInt 1.00x at 10): small gains, a few cells just under 1.00x (at most 8% slower, so they run). Their main gain is not allocating, which this bench barely sees; a bench that counts allocations or GC time could bring them back.

### Wins on every tier

| Rule | Range |
|---|---|
| `for-in-array` | 1.68–33.96x |
| `spread-in-accumulator` | 1.30–31.80x (at 100 items) |
| `accumulate-by-copy-in-loop` | 1.32–26.09x (at 100 items) |
| `object-entries-iteration` | 2.18–13.71x |
| `regexp-constructor-literal` | 1.51–8.52x |
| `indexof-to-startswith` | 1.05–7.51x |
| `array-literal-lookup` | 1.18–5.26x |
| `unused-map` | 1.02–2.23x |
| `filter-first` | 1.09–1.90x |
| `split-join-to-replaceall` | 1.02–1.83x |
| `object-assign-to-spread` | 1.05–1.70x |
| `date-now` | 1.04–1.64x |
| `redundant-array-copy` | 1.02–1.53x |
| `regex-to-string-method` | 1.07–1.48x |

### Not benched

`sequential-await` and `large-object-literal`: a per-call CPU bench cannot show their gain (`SKIPPED` in `gen.ts`).
