# optilint

Performance linter/fixer for JS/TS. Bun runtime, TypeScript 6 compiler API (pinned: TS 7 only ships an unstable IPC API).
- No Bun-only APIs in `src/`: `scripts/bundle.ts` builds a Node copy that the VS Code extension ships (`test/node.test.ts` runs it on `node`). Enforced by types: `src/` projects get `@types/node` 24 (VS Code's Electron), only `test/` and `scripts/` get Bun types.
- TS project references (`tsc -b`; options in `tsconfig.base.json`, declarations go to gitignored `.tsbuild/`). Layers: `src/core` ← `src/rules/<target>` ← `src` (app, incl. `rules/index.ts`) ← `test`. A rule folder may import only core.

- Run: `optilint <paths> [--fix [--tier T] [--obscure]|--diff]` (`bun link` put it on PATH; same as `bun src/cli.ts`). Test: `bun test`. Types: `bun run typecheck` (`tsc -b`; `bun check` 1.4.4 passes files with syntax errors). After changing rules, run `bun run schema` (a test compares `schema.json`).
- `src/core/engine.ts`: program creation, kind-dispatch, multi-pass fix loop. `src/core/context.ts`: per-file `RuleContext` (type queries, disable directives, unique names).
- `src/runner.ts`: the lint run shared by `cli.ts` and `mcp.ts` (`optilint --mcp`, hand-rolled JSON-RPC on stdio); bad input throws `UsageError`. `skills/optilint/SKILL.md` is the agent skill.
- `src/config.ts` loads and layers config (`validate.ts` checks it, `schema.ts` describes it); `report.ts` and `sarif.ts` format output.
- Rules live in `src/rules/<target>/*.ts` (`shared` must win on every engine; `browser` for DOM rules; see `proposals/README.md` for targets; a new folder needs a `tsconfig.json` like `shared`'s and a reference in the root and `src` configs), registered by config group in `src/rules/index.ts` (groups are config names, independent of folders). Each declares `kinds` and `tiers`, and reports via `ctx.report(node, msg, fix(tier, edits, assumes))` from `src/core/fix.ts`.
- Tiers: `exact` = identical for every input; `typed` = for every input the types allow; `assumed` = needs the `assumes` text to hold. Use `byType(ctx.isArray(...))` (`yes` → typed, `maybe` → assumed, `no` → skip). Mark hard-to-read fixes `obscure`.
- Every new fix needs a test in `test/`; add a runnable case to `test/semantics.test.ts` when it rewrites JS semantics.
- Keep files under 300 lines.
