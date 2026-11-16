# Benches of the fixes

Each case in `cases/` is the code a rule finds. `gen.ts` runs optilint's fixer on it (only that rule, `--tier assumed --obscure`), so the bench times what optilint emits, not a hand copy. `child.ts` then checks that both versions return the same results and times them, in a new process per case and tier.

```sh
bun run bench                          # every case, peak tier of node and bun
bun run bench foreach-to-for --show    # one rule; print the code before and after the fix
bun run bench --tiers all --json out.json   # about 7 minutes
```

- `--tiers`: `peak` (default), `all`, or a list such as `node,bun:dfg` (ids in `tiers.ts`).
- `--time MS`: minimum time per measurement (default 150). `--rounds N`: before/after pairs, alternating which goes first (default 3).
- The table shows before time / after time per call: above `1.00x`, the fix is faster. `?` marks a cell whose rounds differ by over 20%: the machine was not steady, so re-run that case.

Lower tiers matter because most flagged code never gets hot enough for TurboFan or FTL. A fix that wins only at the peak tier helps hot loops; one that wins at every tier helps cold app code too.

Results and what they mean for each rule: [`FINDINGS.md`](FINDINGS.md).

## Shipping the numbers

optilint's `maxSlowdown` setting reads `src/speedups.ts`, generated from a full run:

```sh
bun run bench --tiers all --json bench/results/DATE.json > bench/results/DATE.txt
bun run bench:speedups        # newest bench/results/*.json → src/speedups.ts
```

Unsteady results (`?`) are left out. A test fails when `src/speedups.ts` does not match the newest results file.

## Adding a case

Add an entry to the `cases/<group>.ts` file of the rule's config group. `code` must declare `export function run(input)`, `inputs(size)` returns a few variants, and nothing may mutate them. `test/bench.test.ts` fails when a fixable rule has no case (or no reason in `SKIPPED`, `gen.ts`), when a case stops triggering its fix, or when a fix changes a result.
