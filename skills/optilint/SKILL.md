---
name: optilint
description: Find and fix performance problems in JavaScript and TypeScript with optilint, a type-checked linter whose fixes carry a safety tier. Use when asked to speed up, optimize or review the performance of JS/TS code, when touching hot loops, array pipelines or async code, or when optilint findings appear.
---

# optilint

optilint uses the TypeScript compiler to find slow patterns (`.filter()[0]`, spreads in `reduce`, `await` in loops, lookups in loops, and others) and rewrites many of them. Every fix has a **tier**:

| Tier | Meaning | What to do |
|---|---|---|
| `exact` | Same behaviour for every input. | Apply. |
| `typed` | Same behaviour for every input the types allow. | Apply, unless the types lie (`any` casts, unchecked JSON). |
| `assumed` | Correct only if the `assumes` text holds. | Check the assumption against the code first. |

A fix marked `obscure` is correct but hard to read (`x | 0` for `Math.trunc`). Apply it only when the user asks for it or the code is a measured hot path. A finding without a fix is advice.

## Running it

Use the optilint MCP tools if you have them: `lint`, `fix` (returns a diff, writes only with `write: true`), and `rules`. Otherwise use the CLI:

```sh
optilint src --format json          # findings, each with fix.tier and fix.assumes
optilint src --diff                 # preview the exact and typed fixes
optilint src --fix                  # apply them
optilint --explain RULE             # what a rule finds and why it is slow
```

If `optilint` is not on PATH, ask the user how they run it. Configuration lives in `optilint.json` (or the `"optilint"` key of `package.json`). Read it before you change rule settings.

## Workflow

1. Lint the files in scope, not the whole repo, unless asked. Respect the config: a rule the project turned off stays off.
2. Apply `exact` and `typed` fixes with `--fix` (or `fix`). Review the diff; a rewrite next to a type cast deserves a second look.
3. For each `assumed` fix, read its `assumes` text and check it in the code. Example: "the receiver is an array without holes" means you find where the array comes from and rule out `new Array(n)` and `delete`. Apply the fixes that hold one at a time, with `optilint FILE --fix --tier assumed --rule NAME` or by hand. Leave the rest alone.
4. For report-only findings (no fix), change code only when it is on a hot path or a profile shows it. Say why you left the others.
5. Run the project's type check and tests after fixing.

To silence a finding that is deliberate, add `// optilint-disable-next-line RULE` with a short reason, or turn the rule off in `optilint.json`. Do not add disable comments in bulk to make output clean.

## Reporting back

Group what you did by tier: how many exact and typed fixes you applied, which assumed fixes you applied and why each assumption holds, and which findings you left and why.
