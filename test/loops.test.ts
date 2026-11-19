import { describe, expect, test } from "bun:test";
import { fixed, rulesHit, run } from "./helpers.ts";

const ARR = "declare const xs: number[];\n";

describe("foreach-to-for", () => {
  test("block body with index and early return", () => {
    const code = `${ARR}xs.forEach((x, i) => {
  if (x < 0) return;
  console.log(x, i);
});`;
    expect(fixed(code, "foreach-to-for")).toBe(`${ARR}for (let i = 0, len = xs.length; i < len; i++) {
  const x = xs[i];
  if (x === undefined && !(i in xs)) continue;
  if (x < 0) continue;
  console.log(x, i);
}`);
  });
  test("expression body", () => {
    expect(fixed(`${ARR}xs.forEach((x) => console.log(x));`, "foreach-to-for"))
      .toBe(`${ARR}for (let i = 0, len = xs.length; i < len; i++) {\n  const x = xs[i];\n  if (x === undefined && !(i in xs)) continue;\n  console.log(x);\n}`);
  });
  test("receiver shadowed by the parameter is hoisted", () => {
    const code = "declare const x: { items: number[] };\nx.items.forEach((x) => console.log(x));";
    expect(fixed(code, "foreach-to-for")).toBe(
      "declare const x: { items: number[] };\nconst arr = x.items;\nfor (let i = 0, len = arr.length; i < len; i++) {\n  const x = arr[i];\n  if (x === undefined && !(i in arr)) continue;\n  console.log(x);\n}",
    );
  });
  test("hoisting under a braceless if wraps in a block", () => {
    const code = "declare const c: boolean; declare const get: () => number[];\nif (c) get().forEach((v) => console.log(v));";
    const out = fixed(code, "foreach-to-for");
    expect(out).toContain("if (c) {\n  const arr = get();\n  for (let i = 0, len = arr.length; i < len; i++) {");
    expect(out.trimEnd().endsWith("}\n}")).toBe(true);
  });
  test("a destructured element, or none, is guarded with `in` before the read", () => {
    const out = fixed("declare const ps: [number, number][];\nps.forEach(([a, b]) => console.log(a, b));", "foreach-to-for");
    expect(out).toContain("  if (!(i in ps)) continue;\n  const [a, b] = ps[i];");
    expect(fixed(`${ARR}xs.forEach((_, i) => console.log(i));`, "foreach-to-for")).toContain("const _ = xs[i];\n  if (_ === undefined && !(i in xs)) continue;");
  });
  test("no hole test for a fresh array without holes, or a module const that is only read", () => {
    const plain = (code: string) => fixed(code, "foreach-to-for");
    const fresh = plain(`${ARR}xs.filter((x) => x > 0).forEach((x) => console.log(x));`);
    expect(fresh).toContain("const x = arr[i];\n  console.log(x);");
    const local = plain(`export {};\nconst ids = [1, 2, 3];\nconsole.log(ids.length, ids[0], ids.includes(2));\nids.forEach((id) => console.log(id));`);
    expect(local).toContain("const id = ids[i];\n  console.log(id);");
    expect(plain(`export {};\nconst ids = [1, 2, 3];\nids.forEach((_, i) => console.log(i));`)).not.toContain(" in ids");
  });
  test.each([
    ["deleted", "delete ids[1];"],
    ["length written", "ids.length = 9;"],
    ["element written", "ids[5] = 1;"],
    ["grown", "ids.push(4);"],
    ["passed on", "keep(ids);"],
    ["aliased", "const b = ids;"],
    ["callback that can take the array", "ids.map(keep);"],
    ["exported", "export { ids };"],
  ])("keeps the hole test for a const array that is %s", (_name, use) => {
    const code = `declare function keep(...a: unknown[]): void;\nexport {};\nconst ids = [1, 2, 3];\n${use}\nids.forEach((id) => console.log(id));`;
    expect(fixed(code, "foreach-to-for")).toContain("if (id === undefined && !(i in ids)) continue;");
  });
  test("reassigned element uses let; noUncheckedIndexedAccess adds !", () => {
    const out = fixed(`${ARR}xs.forEach((x: number) => { x++; });`, "foreach-to-for", "typed", {
      compilerOptions: { noUncheckedIndexedAccess: true },
    });
    expect(out).toContain("let x: number = xs[i]!;");
  });
  test.each([
    ["async callback", "xs.forEach(async (x) => { await x; });"],
    ["return with value", "xs.forEach((x) => { return x; });"],
    ["return inside nested loop", "xs.forEach((x) => { for (;;) { return; } });"],
    ["thisArg", "xs.forEach((x) => x, {});"],
    ["this in function expression", "xs.forEach(function (x) { this.y = x; });"],
    ["var in body", "xs.forEach((x) => { var y = x; });"],
  ])("bails on %s", (_name, body) => {
    const r = run(`${ARR}${body}`, { rule: "foreach-to-for" });
    expect(r.findings).toEqual([]);
  });
  test("Map.forEach is not touched", () => {
    expect(rulesHit("declare const m: Map<string, number>;\nm.forEach((v) => v);", { rule: "foreach-to-for" })).toEqual([]);
  });
  test("unknown receiver gets an unsafe fix", () => {
    const r = run("function f(a) { a.forEach((x) => x); }", { rule: "foreach-to-for", file: "/virtual/a.js" });
    expect(r.findings[0]?.fix?.tier).toBe("assumed");
  });
});

describe("for-of-to-indexed", () => {
  test("block body", () => {
    expect(fixed(`${ARR}for (const x of xs) {\n  console.log(x);\n}`, "for-of-to-indexed"))
      .toBe(`${ARR}for (let i = 0; i < xs.length; i++) {\n  const x = xs[i];\n  console.log(x);\n}`);
  });
  test("statement body and destructuring", () => {
    const code = "declare const ps: [number, number][];\nfor (const [a, b] of ps) console.log(a, b);";
    expect(fixed(code, "for-of-to-indexed"))
      .toBe("declare const ps: [number, number][];\nfor (let i = 0; i < ps.length; i++) {\n  const [a, b] = ps[i];\n  console.log(a, b);\n}");
  });
  test("ignores mixed unions and unknown iterables", () => {
    expect(rulesHit("declare const p: Set<RegExp> | undefined;\nfor (const x of p ?? []) {}", { rule: "for-of-to-indexed" })).toEqual([]);
    expect(rulesHit("function f(m) { for (const [k] of m.entries()) {} }", { rule: "for-of-to-indexed", file: "/virtual/a.js" })).toEqual([]);
    expect(rulesHit("function f(m) { m.entries().forEach((e) => e); }", { rule: "foreach-to-for", file: "/virtual/a.js" })).toEqual([]);
  });
  test("ignores sets, strings and for-await", () => {
    expect(rulesHit("declare const s: Set<number>; declare const t: string;\nfor (const x of s) {}\nfor (const c of t) {}", { rule: "for-of-to-indexed" })).toEqual([]);
  });
});

describe("for-in-array", () => {
  test("unsafe fix to an indexed loop", () => {
    expect(fixed(`${ARR}for (const k in xs) console.log(xs[k]);`, "for-in-array", "assumed"))
      .toBe(`${ARR}for (let k = 0; k < xs.length; k++) console.log(xs[k]);`);
  });
  test("objects are fine", () => {
    expect(rulesHit("declare const o: Record<string, number>;\nfor (const k in o) {}", { rule: "for-in-array" })).toEqual([]);
  });
});

describe("cache-array-length", () => {
  test("safe when the body only reads", () => {
    const code = `${ARR}let s = 0;\nfor (let i = 0; i < xs.length; i++) s += xs[i]!;`;
    expect(fixed(code, "cache-array-length")).toBe(`${ARR}let s = 0;\nfor (let i = 0, len = xs.length; i < len; i++) s += xs[i]!;`);
  });
  test("push in the body blocks it", () => {
    expect(rulesHit(`${ARR}for (let i = 0; i < xs.length; i++) xs.push(1);`, { rule: "cache-array-length" })).toEqual([]);
  });
  test("calls make it unsafe", () => {
    const r = run(`${ARR}for (let i = 0; i < xs.length; i++) console.log(xs[i]);`, { rule: "cache-array-length" });
    expect(r.findings[0]?.fix?.tier).toBe("assumed");
  });
  test("strings are left alone: their length cannot change", () => {
    expect(rulesHit(`declare const s: string;\nlet n = 0;\nfor (let i = 0; i < s.length; i++) n += s.charCodeAt(i);`, { rule: "cache-array-length" })).toEqual([]);
  });
  test("names are unique per function, not per file", () => {
    const loop = (f: string) => `function ${f}() { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]!; return s; }`;
    const out = fixed(`${ARR}${loop("a")}\n${loop("b")}`, "cache-array-length");
    expect(out.match(/\blen\d*\b/g)).toEqual(["len", "len", "len", "len"]);
    const two = fixed(`${ARR}function c() { let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i]!;\n  for (let j = 0; j < xs.length; j++) s += xs[j]!;\n  return s; }`, "cache-array-length");
    expect(two.match(/\blen\d*\b/g)).toEqual(["len", "len", "len2", "len2"]);
  });
});

describe("lookups", () => {
  test("lookup-in-loop flags invariant arrays only", () => {
    const code = `${ARR}declare const ys: number[];
for (const y of ys) { if (xs.includes(y)) {} }
ys.filter((y) => xs.some((x) => x === y));
for (const y of ys) { const local = [y]; local.includes(1); }
declare const s: string;
for (const y of ys) { s.includes("a"); }`;
    expect(rulesHit(code, { rule: "lookup-in-loop" })).toEqual(["lookup-in-loop", "lookup-in-loop"]);
  });
  test("lookup-in-loop skips arrays known to be small", () => {
    const code = `declare const ys: number[];
const FEW = [1, 2, 3];
const GROWN = [1, 2]; GROWN.push(3);
declare const pair: [number, number];
function f(...names: number[]) { for (const y of ys) names.includes(y); }
for (const y of ys) { FEW.includes(y); pair.includes(y); GROWN.includes(y); }`;
    expect(run(code, { rule: "lookup-in-loop" }).findings.map((f) => f.line)).toEqual([6]);
  });
  test("lookup-in-loop knows Object.keys of a small const literal, through imports too", () => {
    const code = `declare const ys: string[];
import { NAMES } from "./names";
const OPTS = { a: 1, b: 2 };
const KEYS = Object.keys(OPTS);
const BIG = Object.keys(OPTS); BIG.push("c");
for (const y of ys) { KEYS.includes(y); NAMES.includes(y); BIG.includes(y); }`;
    const extra = { "/virtual/names.ts": "const ALL = { x: 1, y: 2 };\nexport const NAMES = Object.keys(ALL);\n" };
    expect(run(code, { rule: "lookup-in-loop", extra }).findings.map((f) => f.line)).toEqual([6]);
  });
  test("lookup-in-loop skips lookups only when every enclosing loop is small", () => {
    const code = `declare const ys: string[]; declare const zs: string[];
const T = [["a", 1], ["b", 2]] as const;
T.filter(([k]) => ys.includes(k));
for (const t of T) ys.indexOf(t[0]);
for (const z of zs) for (const t of T) ys.includes(t[0] + z);`;
    expect(run(code, { rule: "lookup-in-loop" }).findings.map((f) => f.line)).toEqual([5]);
  });
  test("lookup-in-loop skips throw paths and non-equality predicates", () => {
    const code = `${ARR}declare const ys: number[];
for (const y of ys) { if (y < 0) throw new Error(String(xs.indexOf(y))); }
ys.filter((y) => xs.some((x) => x > y));
ys.filter((y) => xs.find((x) => { return x === y; }));`;
    expect(rulesHit(code, { rule: "lookup-in-loop" })).toEqual(["lookup-in-loop"]);
  });
  test("quadratic-array-mutation ignores a different array per iteration", () => {
    const code = "declare const issues: { path: string[] }[];\nfor (const iss of issues) iss.path.unshift('root');";
    expect(rulesHit(code, { rule: "quadratic-array-mutation" })).toEqual([]);
  });
  test("array-literal-lookup: few items become comparisons", () => {
    expect(fixed("function f(k: string) { return ['a', 'b'].includes(k); }", "array-literal-lookup"))
      .toBe("function f(k: string) { return k === 'a' || k === 'b'; }");
  });
  test("array-literal-lookup: many items hoist a Set above leading comments", () => {
    const code = "// doc\nfunction f(kind: string) {\n  if ([1, 2, 3, 4, 5, 6, 7].includes(kind.length)) return 1;\n}";
    expect(fixed(code, "array-literal-lookup"))
      .toBe("const LENGTH_SET = new Set([1, 2, 3, 4, 5, 6, 7]);\n\n// doc\nfunction f(kind: string) {\n  if (LENGTH_SET.has(kind.length)) return 1;\n}");
  });
  test("array-literal-lookup ignores top-level one-offs", () => {
    expect(rulesHit("declare const k: string;\nconst ok = ['a', 'b'].includes(k);", { rule: "array-literal-lookup" })).toEqual([]);
  });
  test("quadratic-array-mutation", () => {
    const code = `${ARR}while (xs.length) { xs.shift(); xs.splice(0, 1); xs.splice(0, 0); }`;
    expect(rulesHit(code, { rule: "quadratic-array-mutation" })).toEqual(["quadratic-array-mutation", "quadratic-array-mutation"]);
  });
});
