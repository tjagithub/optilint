# Usage

```sh
optilint                         # report on the current folder
optilint src --diff              # preview fixes
optilint src --fix               # apply exact and typed fixes
optilint --ui                    # review by tier and pick fixes in the browser
optilint --explain lookup-in-loop
```

## Fix tiers

Every fix states what it guarantees:

| Tier | Same behaviour… | Example |
|---|---|---|
| `exact` | for every input | `new Date().getTime()` → `Date.now()` |
| `typed` | for every input the types allow | `xs.filter(f).length > 0` → `xs.some(f)` when `xs: T[]` |
| `assumed` | only if the fix's stated assumption holds | `Promise.all` for sequential awaits |

`--fix` applies `exact` and `typed`. Add `--tier assumed` for the rest, after you check each assumption; `--ui` shows them side by side so you can pick. Findings without a fix are advice: change that code when it is hot.

## Hot code first

Point optilint at a CPU profile and it ranks findings by the time spent where they are, and drops code that never ran to low impact:

```sh
node --cpu-prof --cpu-prof-dir=prof dist/server.js
optilint src --profile prof/*.cpuprofile --min-impact medium
```

## In CI

```sh
optilint --format sarif > optilint.sarif   # for GitHub code scanning
optilint --cache                           # reuse findings for unchanged files
```

The exit code is 1 when findings remain and 2 on usage errors. `optilint --help` lists every flag; [Configuration](configuration.md) covers `optilint.json`.
