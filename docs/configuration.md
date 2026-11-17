# Configuration

optilint uses the nearest `optilint.json` or `optilint.jsonc` (or an `"optilint"` key in `package.json`) from the working directory upward, or `--config PATH`. With `--stdin-filename`, it searches from that file's folder. Both files may have comments and trailing commas, as `tsconfig.json` does.

```jsonc
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
  // Tests and benchmarks await in order on purpose.
  "overrides": [{ "include": ["test/**", "bench/**"], "rules": { "async": "off" } }]
}
```

- `rules` applies its `preset` (`recommended`, `all` or `none`), then groups, then single rules, so the most specific setting wins. A level is `off`, `on`, `info`, `warn` or `error`; the last three also set the finding's `severity`.
- The recommended preset leaves out `for-of-to-indexed`, `bitwise-trunc` and `large-object-literal`.
- `tier` is the highest tier `--fix` applies (default `typed`). A rule's own `tier` can only raise its fixes (from `typed` to `assumed`, say), or drop them with `"none"`. It cannot make an `assumed` fix count as `typed`.
- `obscure: true` lets `--fix` apply fixes that are correct but hard to read, such as `Math.trunc(x)` → `x | 0`.
- `minImpact` hides findings below `high`, `medium` or `low` impact.
- `maxSlowdown` (default `"10%"`) drops rules whose fix was measured more than that much slower than the original code on some engine, compiler tier or input size. The 10% allows for measurement noise. `"0%"` drops every fix that was slower anywhere, and `"any"` runs them all. Rules without a measured fix (report-only ones) always run. `optilint --explain <rule>` shows its measured range.
- Globs are relative to the file that declares them; a folder name also covers what is inside it. `extends` paths are relative too, and later files win.
- Unknown keys, rules and groups are errors with a suggestion. `schema.json` (also printed by `optilint --print-schema config`) gives editors completion and hover docs.

The command line overrides the config: `--rule a,b` and `--disable a,b` (rules or groups), `--tier`, `--obscure`, `--min-impact`, `--max-slowdown`, `--ignore GLOB` (repeatable), `--project tsconfig.json`. `--rule` and `--disable` can repeat. `--fix-unsafe` is short for `--fix --tier assumed`.

## Cache

`--cache` stores each file's findings (in `node_modules/.cache/optilint/cache.json`, or `.optilintcache` without a `node_modules`; `--cache-location PATH` to choose) and reuses them while the file's key holds. Types cross files, so the key covers more than the file: its content, the content of everything it imports (transitively, through `.d.ts` files in `node_modules` too), every script and `declare global` / `declare module` file the run reaches, the compiler options, the file's rule settings, and the optilint and TypeScript versions. An import that does not resolve is part of the key, so the file is linted again once it does. `--fix` and `--diff` ignore the cache.

## Disable comments

```ts
// optilint-disable-next-line rule-a, rule-b
doSomething(); // optilint-disable-line
/* optilint-disable-file rule-a */
```

Without rule names, a comment disables every rule.
