# Roadmap

What's planned for optilint, roughly in order. Nothing here is a promise: every rule still has to pass the bar in [CONTRIBUTING.md](CONTRIBUTING.md#what-makes-a-rule), starting with a measured win. Shipped changes are in the [releases](https://github.com/tjagithub/optilint/releases).

## Planned

- **More from `targets`.** The config key exists, and picks which engines' measurements count against `maxSlowdown`. Still to come: runtime rules that only run for their runtime (Node, Bun, browsers), engine-only rules, and detecting targets like `domains` (from `engines` in `package.json`, browserslist, `lib: ["dom"]`; a `bun.lock` alone only shows the package manager). The first engine-only candidate is `delete-property`: V8 turns an object into a dictionary on `delete`, while JavaScriptCore keeps a cacheable shape, but it needs a benchmark first.
- **Node runtime rules** (with `targets: ["node"]`): `Buffer.concat` in a loop (quadratic copying), round trips such as `Buffer.from(b.toString())`, and `*Sync` I/O inside request handlers (report-only, and scoped so that CLIs aren't flooded).
- **Type-check cost.** `--type-cost` ranks files and declarations by type instantiations and check time, using the counters TypeScript exposes on a program. Then rules from the TypeScript wiki's performance page (interfaces over intersections, explicit return types on exports, large unions), each confirmed with those counters on both tsc 6 and TypeScript 7.
- **Shared flow analysis** in `src/core` (loop invariance, escape, aliasing), so that more rules can prove a fix safe instead of reporting only.
- **Faster startup.** Node's module compile cache in the bundle (measured about 9%), then profiling TypeScript program creation, which is most of the rest.

## Under consideration

Rules, each benchmarked on both engines before it ships:

- Plain objects used as dictionaries (keys added and deleted) → `Map`, report-only.
- Numeric arrays mixing in `undefined` in hot loops → typed arrays, report-only (the fix is a redesign).
- `JSON.parse(JSON.stringify(x))` → `structuredClone`, which may turn out slower.
- Bit tricks as `assumed` or `obscure` fixes: `n % 2` → `n & 1`, `switch` → lookup table, single-character regex → `charCodeAt`.
- A regex character class instead of a hoisted `Set` of single characters (2.7–5× faster in one measured case).

Editors and agents:

- VS Code: choose which tiers show as diagnostics, a "disable rule" action that writes `optilint.json`, and preferring the project's own installed optilint over the bundled one (in trusted workspaces).
- MCP: `structuredContent` with an output schema once clients use it, and a cap on `lint` results for very large repos.

## Won't do

Measured or checked, and left out on purpose:

- **Fixes that measured slower:** `array-from-map` and `object-entries-pair` are retired ([bench/FINDINGS.md](bench/FINDINGS.md)). They keep their tests and benchmarks, so a future engine can bring them back.
- **Myths on current engines:** avoiding try/catch in loops, preallocating with `new Array(n)`, primitive boxing (`"s".length`), regex literals in loops, and string `+=` in loops (engines build ropes).
- **Bun APIs instead of Node's** (`Bun.file`, `Bun.write`): Bun's `node:` modules call the same native code. No gain measured, and `Bun.write` was slower on large files.
- **Guesses that need runtime information:** number representation (TypeScript's `number` doesn't say integer or double), polymorphic property access, JSON payload size, deoptimizations. Messages say a pattern "can" be slow; optilint never claims a deopt it cannot see.
- **V8 compile-hint comments:** no effect measured on Node; they're load-time tuning for Chrome.
- **`forEach(async …)`:** a correctness bug rather than a speed one, covered by typescript-eslint's `no-misused-promises`.
