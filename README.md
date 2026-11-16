# optilint

A linter for JavaScript and TypeScript that only cares about speed. It finds slow patterns and rewrites them into faster ones: O(n²) accumulators, linear lookups in loops, needless allocations, regexes where a string method would do, sequential awaits, and engine-level tricks.

It uses the TypeScript 6 compiler API, so rules can ask the type checker whether something really is an array or a string before rewriting it.

## Usage

```sh
bun install && bun link               # puts `optilint` on PATH (~/.bun/bin), pointing at this checkout
optilint [paths...]                   # report (default: .)
optilint src --diff                   # preview fixes as a unified diff
optilint src --fix                    # apply exact and typed fixes
optilint src --fix --tier assumed     # also apply fixes that rely on a stated assumption
optilint --list-rules
optilint --explain spread-in-accumulator
```

`bun run bundle [outdir]` builds a copy that runs on plain Node (`node dist/optilint.mjs`), with TypeScript and its lib files beside it. The VS Code extension ships this build.

Other flags: `--rule a,b` and `--disable a,b` (rules or groups), `--obscure`, `--min-impact high|medium|low`, `--max-slowdown 10%`, `--format pretty|json|sarif`, `--config PATH`, `--project tsconfig.json`, `--ignore GLOB` (repeatable). `--fix-unsafe` is short for `--fix --tier assumed`. Exit code is 1 when findings remain (findings set to `info` do not count), 2 on usage errors.

## Fix tiers

Every fix has a tier, which says what it guarantees:

| Tier | Same behaviour… | Example |
|---|---|---|
| `exact` | for every input | `new Date().getTime()` → `Date.now()` |
| `typed` | for every input the types allow | `xs.filter(f)[0]` → `xs.find(f)` when `xs: T[]` |
| `assumed` | only if the fix's `assumes` holds | `Promise.all` for sequential awaits; `filter`/`find` on an untyped `xs` |

- `--fix` applies up to `typed` by default; `--tier` or the config's `tier` changes that.
- Most rules give `typed` when the checker proves the receiver's type and `assumed` when it is `any`/`unknown`. A union with one non-matching member (`Set<T> | T[]`) counts as "not an array", and the rule stays quiet.
- `typed` takes arrays to be dense: a holey array (`[1, , 3]`, `new Array(n)`) can behave differently in loops.
- Separately, a fix can be **obscure**: correct for its tier but hard to read, like `Math.trunc(x)` → `x | 0`. `--fix` skips those unless you pass `--obscure` or set `"obscure": true`.
- Fixes are applied in up to 10 passes, so they compose: `xs.map(f);` → `xs.forEach(f)` → an indexed loop.

## Config

optilint uses the nearest `optilint.json` (or an `"optilint"` key in `package.json`) from the working directory upward, or `--config PATH`. With `--stdin-filename`, it searches from that file's folder.

```json
{
  "$schema": "./node_modules/optilint/schema.json",
  "extends": ["./optilint.base.json"],
  "files": { "include": ["src/**"], "ignore": ["src/generated/**"] },
  "tier": "typed",
  "obscure": false,
  "minImpact": "low",
  "maxSlowdown": "10%",
  "rules": {
    "preset": "recommended",
    "async": "warn",
    "misc": { "bitwise-trunc": { "level": "info", "tier": "assumed" } },
    "foreach-to-for": "off"
  },
  "overrides": [{ "include": ["test/**", "bench/**"], "rules": { "async": "off" } }]
}
```

- `rules` applies its `preset` (`recommended`, `all` or `none`), then groups, then single rules, so the most specific setting wins. A level is `off`, `on`, `info`, `warn` or `error`; the last three also set the finding's `severity`.
- A rule's `tier` can only raise its fixes (from `typed` to `assumed`, say), or drop them with `"none"`. It cannot make an `assumed` fix count as `typed`.
- The recommended preset leaves out `for-of-to-indexed`, `bitwise-trunc` and `large-object-literal`.
- `maxSlowdown` (default `"10%"`) drops rules whose fix was measured more than that much slower than the original code on some engine, compiler tier or input size (`bench/`). The 10% allows for measurement noise. `"0%"` drops every fix that was slower anywhere, and `"any"` runs them all. Rules without a measured fix (report-only ones) always run. `--explain <rule>` shows its measured range.
- Globs are relative to the file that declares them; a folder name also covers what is inside it. `extends` paths are relative too, and later files win.
- Unknown keys, rules and groups are errors with a suggestion. `schema.json` (from `--print-schema config`) gives editors completion and hover docs.

Inline: `// optilint-disable-next-line rule-a, rule-b`, `// optilint-disable-line`, `/* optilint-disable-file rule-a */`.

## Output for other tools

- `--format json` prints `{ "version": 1, "tool": {...}, "findings": [...] }`, described by `output.schema.json` (`--print-schema output`). Each finding has its `group`, `impact`, optional `severity`, start and end positions, and `fix: { tier, assumes?, obscure?, edits } | null`. Edit offsets count UTF-16 code units, as editors do.
- `--format sarif` prints SARIF 2.1.0 with fixes as replacements, for GitHub code scanning and other SARIF viewers.
- `--list-rules --format json` prints every rule's metadata.
- `--stdin-filename path/to/file.ts` lints stdin as that file; with `--fix` it prints the fixed text. Editors use this for unsaved buffers.

## For coding agents

- **Skill:** `skills/optilint/SKILL.md` ([Agent Skills](https://agentskills.io) format) teaches an agent the tiers: apply exact and typed fixes, check each assumed fix's assumption first, and leave report-only findings unless the code is hot. The repo is also a Claude Code plugin (`.claude-plugin/plugin.json`) that ships just this skill.
- **MCP server:** `optilint --mcp` serves three tools on stdio: `lint` (files or a code snippet), `fix` (returns fixed text or a diff; writes files only with `write: true`) and `rules`. Paths must be inside the directory it runs in. Add it to Claude Code with `claude mcp add optilint -- optilint --mcp`.
- The VS Code extension registers both for Copilot and other VS Code agents.

An agent with a shell does as well with the CLI and the skill, and does not pay for the MCP tool descriptions in every session.

## Rules

| Area | Rules |
|---|---|
| Complexity (O(n²)) | `spread-in-accumulator`, `accumulate-by-copy-in-loop`, `lookup-in-loop`, `quadratic-array-mutation`, `sort-for-extremum` |
| Async | `await-in-loop`, `sequential-await` |
| Allocation | `filter-first`, `filter-length-to-some`, `map-flat-to-flatmap`, `unused-map`, `redundant-array-copy`, `chained-array-methods`, `array-literal-lookup`, `object-entries-iteration`, `object-keys-emptiness`, `date-now` |
| Loops | `foreach-to-for`, `for-of-to-indexed`, `for-in-array`, `cache-array-length` |
| Strings and regex | `split-join-to-replaceall`, `regex-to-string-method`, `match-to-test`, `indexof-to-startswith`, `regexp-constructor-literal`, `catastrophic-regex` |
| Engine | `object-assign-to-spread`, `delete-property`, `large-object-literal` (JSON.parse trick), `math-pow-to-mul`, `bitwise-trunc`, `math-minmax-spread`, `arguments-object`, `dynamic-code`, `dom-in-loop` |

`--list-rules` shows each rule's impact and fix tiers. `--explain <rule>` says why it is faster.

Retired rules never run, because their fix measured slower (`bench/FINDINGS.md`): `array-from-map` and `object-entries-pair` (`[k, v]` from `Object.entries`). They are kept so a later bench run on newer engines can bring them back; `--explain` gives the reason.

### Left out on purpose

Some well-known "tricks" no longer pay off in modern engines, so there are no rules for them:

- `+=` string building in loops (V8 uses ropes, and `join` is usually slower).
- try/catch in hot functions (TurboFan optimizes it).
- `structuredClone` over `JSON.parse(JSON.stringify())` (it is often slower).
- `x << 1` instead of `x * 2` (the JIT already does this).

## Validation

Apart from the unit tests (`bun test`), `test/semantics.test.ts` runs a set of programs that exercise the fix rules and checks that each returns the same value before and after `--fix`.

Round-trip on zod v4 (`src/v4`, sources and tests; 1520 passing tests), measured before tiers and presets existed, with every rule on: `--fix` (now `exact` + `typed`) applied 249 fixes and `--fix-unsafe` (now `--tier assumed --obscure`) applied 487. Both left `tsc --strict` at 0 errors and the test suite with the same set of passing and failing tests as before.

## Limitations

- Impact labels are rules of thumb. Measure hot paths with a benchmark before and after.
- `replaceAll` and `flatMap` fixes are skipped when the project's `lib` lacks them.
- `sequential-await` and `array-literal-lookup` (Set form) rewrite whole statements, so comments between the rewritten statements are dropped.
- The type checker runs on the files you lint plus the `.d.ts` files from your tsconfig. Unresolved imports become `any`, which turns fixes `assumed`.
