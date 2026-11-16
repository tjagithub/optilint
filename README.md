# optilint

A linter for JavaScript and TypeScript that only cares about speed. It finds slow patterns and rewrites them into faster ones: O(n²) accumulators, linear lookups in loops, needless allocations, regexes where a string method would do, sequential awaits.

- **Type-aware:** it uses the TypeScript compiler, so a rule can check that something really is an array before rewriting it.
- **Honest fixes:** every fix says what it guarantees, and `--fix` only applies the safe ones by default.
- **Measured:** every fix is benchmarked on V8 and JavaScriptCore at each compiler tier. Fixes that measured slower don't run.

## Installation

optilint is not on npm yet. To run it from a checkout, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Usage

```sh
optilint                         # report on the current folder
optilint src --diff              # preview fixes
optilint src --fix               # apply exact and typed fixes
optilint --explain lookup-in-loop
```

Every fix has a tier:

| Tier | Same behaviour… | Example |
|---|---|---|
| `exact` | for every input | `new Date().getTime()` → `Date.now()` |
| `typed` | for every input the types allow | `xs.filter(f)[0]` → `xs.find(f)` when `xs: T[]` |
| `assumed` | only if the fix's stated assumption holds | `Promise.all` for sequential awaits |

`--fix` applies `exact` and `typed`; add `--tier assumed` for the rest. `optilint --help` lists every flag.

## Documentation

- [Configuration](docs/configuration.md): `optilint.json`, presets, overrides, disable comments.
- [Rules](docs/rules.md): what each rule does, how fixes are measured, and what is left out on purpose.
- [Editors, CI and agents](docs/integrations.md): JSON and SARIF output, the VS Code extension, the MCP server and the agent skill.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and benchmarks, and how to add a rule.

## License

MIT
