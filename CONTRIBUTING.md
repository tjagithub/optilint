# Contributing

optilint runs on [Bun](https://bun.sh) and the TypeScript 6 compiler API.

## Setup

```sh
bun install
bun link             # puts `optilint` on PATH (~/.bun/bin), pointing at this checkout
optilint --version   # same as `bun src/cli.ts --version`
```

## Commands

| Command | What it does |
|---|---|
| `bun test` | Unit, semantics and CLI tests |
| `bun run typecheck` | `tsc -b` over every project |
| `bun run schema` | Regenerates `schema.json` and `output.schema.json`; run it after changing rules or config (a test compares them) |
| `bun run lint:self` | optilint on its own `src/` |
| `bun run bench [rule] [--tiers all]` | Benchmarks fixes before and after ([bench/README.md](bench/README.md)); a full run takes minutes |
| `bun run bench:speedups` | Regenerates `src/speedups.ts`, which drives `maxSlowdown`, from the newest `bench/results/*.json` |
| `bun run bundle [outdir]` | Builds a copy that runs on plain Node (`node dist/optilint.mjs`), with TypeScript beside it; the VS Code extension ships this |

## Layout

- `src/core`: program creation, kind dispatch, the multi-pass fix loop (`engine.ts`), and the per-file rule context (`context.ts`).
- `src/rules/<target>`: rules. `shared` must win on every engine; `browser` holds DOM rules. A rule folder may import only `core`. Rules are registered by config group in `src/rules/index.ts`.
- `src`: the CLI, the MCP server (`mcp.ts`), config loading and validation, and output formats.
- `bench`: before/after benchmarks per engine and compiler tier; results and what they mean in `bench/FINDINGS.md`.

`src/` must not use Bun-only APIs: `test/node.test.ts` runs the Node bundle, and `src/` projects only get Node's types.

## Adding a rule

- Declare `kinds` and `tiers`, and report with `ctx.report(node, message, fix(tier, edits, assumes))` from `src/core/fix.ts`.
- Pick the tier honestly: `exact` is identical for every input, `typed` for every input the types allow, `assumed` needs its `assumes` text to hold. Holes are allowed by every array type, so a `typed` fix must not change which elements are visited (`isDense` in `src/core/ast.ts`); `test/bench.test.ts` runs every fix on arrays with holes. `byType(ctx.isArray(...))` gives `typed` for "yes" and `assumed` for "maybe". Mark hard-to-read fixes `obscure`.
- Every fix needs a test in `test/`, a runnable case in `test/semantics.test.ts` when it rewrites JS semantics, and a bench case in `bench/cases/` (`test/bench.test.ts` checks this).
- Keep files under 300 lines.

A fix that measures slower is retired, not deleted: set `retired: "<reason, citing bench/FINDINGS.md>"` on the rule. It then never runs, but keeps its tests and bench case.

## Validation

Besides the unit tests, `test/semantics.test.ts` runs programs that exercise the fix rules and checks that each returns the same value before and after `--fix`, and `test/fixpoint.test.ts` checks that no two rules undo each other.

Round trip on zod v4 (`src/v4`, sources and tests; 1520 passing tests), measured before tiers and presets existed, with every rule on: `--fix` (now `exact` + `typed`) applied 249 fixes, and `--fix-unsafe` (now `--tier assumed --obscure`) applied 487. Both left `tsc --strict` at 0 errors and the test suite with the same set of passing and failing tests as before.
