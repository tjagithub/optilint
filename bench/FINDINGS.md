# Bench findings

What `bench/` measured, per rule, and what to do about it. Newest run first; when an engine is upgraded, add a dated run rather than editing an old one. Proposals that act on these link here (`proposals/`).

Ratios are before time ÷ after time: above 1.00x the fix is faster. "Every tier" means all eight: V8 TurboFan, Maglev, Sparkplug, Ignition and JSC FTL, DFG, Baseline, LLInt. Causes marked *unverified* are guesses that still need a look at the engine source (`proposals/README.md`, Sources).

## 2026-11-16

Apple M4, Node v26.13.1 (V8 14.6), Bun 1.4.4 (JSC); `bun run bench --tiers all`, 150 ms per measurement, 3 rounds. Full table: [`results/2026-11-16.txt`](results/2026-11-16.txt). Sizes are 10 and 1000 items (10 and 100 for the quadratic accumulator cases).

### Loses: change or drop the fix

- **`array-from-map`: slower on every tier of both engines** (0.12–0.96x). Worst on V8: TurboFan 0.12–0.15x, Maglev 0.41–0.50x; JSC 0.56–0.96x. `Array.from(set).map(f)` beats `Array.from(set, f)`. *Unverified cause:* the optimizing tiers inline `.map` and its callback, while `Array.from` calls `f` from a builtin.
  **Action:** remove the fix (and the rule, unless a report-only form has a basis). This also settles its tier question in `proposals/shared.md`.
- **`object-entries-iteration`: V8 loses at its top tiers** (TurboFan 0.61x at 10 keys and 0.11x at 1000; Maglev 0.18x at 1000). JSC wins at 10 keys (FTL 7.3x, DFG 6.0x, Baseline 3.9x) but is about even at 1000 (0.84–1.48x). The case uses 8 objects with different keys, so `o[k]` in the fixed loop sees several shapes; a single-shape case may differ.
  **Action:** turn it off for shared targets. Bench a single-shape case before deciding whether it becomes JSC-only (`engines: ["jsc"]`).

### Mixed: loses on some tiers

- **`map-flat-to-flatmap`** (0.32–2.07x): V8 even at TurboFan and 1.1–1.2x below it; JSC FTL 1.4–2.1x, but DFG 0.81x at 1000, Baseline 0.51x and LLInt 0.32–0.38x. So cold code on Bun or Safari gets slower.
- **`for-of-to-indexed`** (0.72–3.17x): wins on every V8 tier (1.18–3.17x) and on JSC FTL and DFG; loses on JSC Baseline (0.72x at 1000) and LLInt (0.87–0.96x). That contradicts its `why` text, which says baseline tiers pay for the iterator protocol. *Unverified cause:* JSC's bytecode has a fast path for for-of over arrays.
- **`bitwise-trunc`** (0.77–1.98x): wins everywhere except JSC Baseline (0.77–0.80x). Already obscure, assumed and not recommended.
- **`math-pow-to-mul`** (0.75–2.89x): wins on every V8 tier and on JSC Baseline and LLInt (1.8–2.9x), but JSC FTL is 0.75x at 1000 (steady in all three runs). *Unverified cause:* FTL already turns `Math.pow(x, 2)` into a multiply.

**Open question for all four:** does the acceptance bar ("wins on both engines", `proposals/README.md`) mean every tier, or the top tiers? If every tier, none of these four passes as a shared fix. Then `map-flat-to-flatmap` and `for-of-to-indexed` would be V8-only, and `math-pow-to-mul` would need a look at why FTL loses.

### Even: no real gain

- **`cache-array-length`** (0.69–1.22x): 1.00x on TurboFan, FTL and DFG at 1000; a small gain only on the lowest tiers (Sparkplug 1.18–1.22x, LLInt 1.16–1.19x). The one loss (Maglev 0.69x at 10) is marked unsteady. This confirms `proposals/shared.md`: not recommended, and fix the `why` text.
- **`filter-length-to-some`** (0.93–1.23x) and **`match-to-test`** (0.97–1.27x): small gains, one cell each just under 1.00x. Keep them; their main gain is not allocating, which this bench barely sees.

### Wins on every tier

| Rule | Range |
|---|---|
| `for-in-array` | 1.69–33.41x |
| `spread-in-accumulator` | 1.30–32.27x (at 100 items) |
| `accumulate-by-copy-in-loop` | 1.33–27.62x (at 100 items) |
| `regexp-constructor-literal` | 1.51–9.12x |
| `indexof-to-startswith` | 1.07–7.61x |
| `array-literal-lookup` | 1.21–5.29x |
| `foreach-to-for` | 1.00–4.24x |
| `unused-map` | 1.03–2.17x |
| `filter-first` | 1.08–1.90x |
| `split-join-to-replaceall` | 1.05–1.82x |
| `object-assign-to-spread` | 1.04–1.70x |
| `date-now` | 1.05–1.62x |
| `redundant-array-copy` | 1.03–1.53x |
| `regex-to-string-method` | 1.07–1.48x |

### Not benched

`sequential-await` and `large-object-literal`: a per-call CPU bench cannot show their gain (`SKIPPED` in `gen.ts`).
