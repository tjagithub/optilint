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
  "domains": { "react": "auto" },
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
- `domains` are groups for one library or tool: `typescript` (package `typescript`) and `react` (`react` or `preact`). With `"auto"` (the default), a domain joins the presets only for files where a `package.json` in the file's folder or above depends on one of its packages, so monorepo packages get their own. `"on"` and `"off"` ignore the dependencies. The presets also leave out rules that a dependency makes redundant: `inline-prop-to-memo` and `inline-context-value` with React Compiler (`babel-plugin-react-compiler`). Naming a group or rule under `rules` turns it on anyway.
- Globs are relative to the file that declares them; a folder name also covers what is inside it. `extends` paths are relative too, and later files win.
- Unknown keys, rules and groups are errors with a suggestion. `schema.json` (also printed by `optilint --print-schema config`) gives editors completion and hover docs.

The command line overrides the config: `--rule a,b` and `--disable a,b` (rules or groups), `--tier`, `--obscure`, `--min-impact`, `--max-slowdown`, `--ignore GLOB` (repeatable), `--project tsconfig.json`. `--rule` and `--disable` can repeat. `--workers N` lints projects on N threads (default: up to 4); it pays off in monorepos with many tsconfig projects and is skipped when one project holds most files, since one program cannot be split. `--fix-unsafe` is short for `--fix --tier assumed`.

## Cache

`--cache` stores each file's findings (in `node_modules/.cache/optilint/cache.json`, or `.optilintcache` without a `node_modules`; `--cache-location PATH` to choose) and reuses them while the file's key holds. Types cross files, so the key covers more than the file: its content, the content of everything it imports (transitively, through `.d.ts` files in `node_modules` too), every script and `declare global` / `declare module` file the run reaches, the compiler options, the file's rule settings, and the optilint and TypeScript versions. An import that does not resolve is part of the key, so the file is linted again once it does. `--fix` and `--diff` ignore the cache.

## CPU profiles

`--profile FILE` (repeatable) reads a `.cpuprofile`, as `node --cpu-prof`, `bun --cpu-prof` or a Chrome DevTools export writes it. Each finding gets `cpu`: the share of profiled time spent in the function that holds it, counting the builtins and libraries it calls (idle time is left out). Findings come hottest first, and files with the hottest finding first. A finding in a function the profile never saw run is marked `cold` and drops to `low` impact, so `--min-impact medium` hides it. Profiles of compiled code map back to the linted sources through `sourceMappingURL` comments (a file or an inline map). Profile a run that does the real work: a short script spends most of its time starting up. The MCP `lint` tool takes the same files as `profile`.

```sh
node --cpu-prof --cpu-prof-dir=prof dist/server.js
optilint src --profile prof/*.cpuprofile --min-impact medium
```

## Disable comments

```ts
// optilint-disable-next-line rule-a, rule-b
doSomething(); // optilint-disable-line
/* optilint-disable-file rule-a */
```

Without rule names, a comment disables every rule. As in ESLint, text after ` -- ` gives the reason: `// optilint-disable-next-line lookup-in-loop -- at most 5 items`.
