# Rules

| Area | Rules |
|---|---|
| Complexity (O(n²)) | `spread-in-accumulator`, `accumulate-by-copy-in-loop`, `lookup-in-loop`, `quadratic-array-mutation`, `sort-for-extremum` |
| Async | `await-in-loop`, `sequential-await` |
| Allocation | `filter-first`, `filter-length-to-some`, `map-flat-to-flatmap`, `unused-map`, `redundant-array-copy`, `typed-array-subarray`, `typed-array-round-trip`, `chained-array-methods`, `array-literal-lookup`, `object-entries-iteration`, `object-keys-emptiness`, `date-now` |
| Loops | `foreach-to-for`, `for-of-to-indexed`, `for-in-array`, `cache-array-length` |
| Strings and regex | `split-join-to-replaceall`, `regex-to-string-method`, `match-to-test`, `indexof-to-startswith`, `regexp-constructor-literal`, `catastrophic-regex`, `string-flatten-in-loop`, `regexp-in-loop` |
| Objects and shapes | `object-keys-in-loop`, `late-property`, `prototype-mutation` |
| Browser and workers | `dom-in-loop`, `passive-listener`, `scroll-layout-read`, `gpu-sync-in-frame`, `per-frame-allocation`, `postmessage-transfer` |
| TypeScript emit (tsconfig) | `downlevel-async`, `define-class-fields`, `downlevel-private-fields` |
| React | `inline-prop-to-memo`, `inline-context-value`, `unstable-key` |
| Engine | `object-assign-to-spread`, `delete-property`, `large-object-literal` (JSON.parse trick), `math-pow-to-mul`, `bitwise-trunc`, `math-minmax-spread`, `arguments-object`, `dynamic-code` |

`optilint --list-rules` shows each rule's impact and fix tiers. `optilint --explain <rule>` says why it is faster, and what it measured.

## Fixes

- Most rules give `typed` when the checker proves the receiver's type, and `assumed` when it is `any` or `unknown`. A union with one non-matching member (`Set<T> | T[]`) counts as "not an array", and the rule stays quiet.
- Any array type can have holes (`[1, , 3]`, `new Array(n)`, `delete xs[i]`). A `typed` fix may take element values to match their type, as TypeScript does, but never changes which elements are visited. `forEach` → `for` keeps skipping holes (without the test when the array provably has none: fresh from `filter` or a literal, or a module-private `const` that is only read), and `filter(f)[0]` → `find(f)` is `typed` only when the array provably has none (a literal without gaps, or the result of `filter`, `split`, `Array.from` or `Object.values`); otherwise it is `assumed`.
- Tiers cover results, not proxies. A Proxy-wrapped array (Vue `reactive`, MobX) gives the same results after a fix, but its traps may run a different number of times (`forEach` calls `has` per element, an indexed loop does not), and its speed can differ: on V8, `forEach` over a Proxy beats an indexed loop by up to 25% (`bench/FINDINGS.md`, 2026-11-19).
- A fix can also be **obscure**: correct for its tier but hard to read. `--fix` skips those unless you pass `--obscure`.
- Fixes are applied in up to 10 passes, so they compose: `xs.map(f);` → `xs.forEach(f)` → an indexed loop.

## Measured, not guessed

Every fix is benchmarked before and after on Node (V8) and Bun (JavaScriptCore), at each of their compiler tiers, from the interpreter up to the top optimizing compiler. A rule whose fix measured more than `maxSlowdown` (default 10%) slower anywhere does not run by default ([configuration](configuration.md)).

Retired rules never run at all, because their fix was slower nearly everywhere: `array-from-map` and `object-entries-pair` (`[k, v]` from `Object.entries`). They are kept so a later run on newer engines can bring them back; `--explain` gives the reason.

## Left out on purpose

Some well-known "tricks" no longer pay off in modern engines, so there are no rules for them:

- `+=` string building in loops (engines use ropes, and `join` is usually slower).
- try/catch in hot functions (optimizing compilers handle it).
- `structuredClone` over `JSON.parse(JSON.stringify())` (it is often slower).
- `x << 1` instead of `x * 2` (the JIT already does this).
- `enum` and `namespace` → literals or module scope: free at the top tiers, except string enums on TurboFan (up to 20% slower), and an `as const` object costs the same as an enum, so the only faster form is inlined literals (`bench/FINDINGS.md`, 2026-11-20).

## TypeScript emit

The `typescript` rules report a cost of what tsc emits, not of the code itself, so they fire only when the project's tsc writes its JavaScript (no `noEmit`, no `emitDeclarationOnly`) with a low `target`. They report once per file, at the first case, and the fix is in tsconfig. A bundler build (esbuild, Vite, SWC) uses its own target, so these rules stay quiet under `noEmit`.

## React

The `react` rules only report. `inline-prop-to-memo` and `inline-context-value` find values made during render that defeat `memo`, `PureComponent` or a context provider. They use React's types when present, and otherwise a `memo(...)` or `createContext(...)` declaration in view, which also covers Preact. React Compiler memoizes these values itself, so the presets leave the two rules out when `babel-plugin-react-compiler` is a dependency, and they skip code under a `"use memo"` directive. The `react` and `typescript` groups are [domains](configuration.md): they run where a `package.json` lists `react` or `preact`, or `typescript`. `unstable-key` flags keys from `Math.random()`, `Date.now()`, `crypto.randomUUID()` or id generators, which remount the element on every render.

## Limitations

- Impact labels are rules of thumb. Measure hot paths with a benchmark before and after.
- `replaceAll` and `flatMap` fixes are skipped when the project's `lib` lacks them.
- `sequential-await` and `array-literal-lookup` (Set form) rewrite whole statements, so comments between the rewritten statements are dropped.
- The type checker sees the files you lint plus the `.d.ts` files from your tsconfig. Unresolved imports become `any`, which turns fixes `assumed`.
