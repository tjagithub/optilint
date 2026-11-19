import { describe, expect, test } from "bun:test";
import { fixed, rulesHit, run } from "./helpers.ts";

const ARR = "declare const xs: number[];\n";

describe("filter-first", () => {
  test("typed on arrays that provably have no holes", () => {
    for (const recv of ["[1, 2, 3]", "Object.values(o)", "Array.from(xs)", "xs.filter(Boolean)", "s.split(\",\")"]) {
      const code = `${ARR}declare const o: Record<string, number>; declare const s: string;\nconst a = ${recv}.filter((x) => x > 1)[0];`;
      expect(fixed(code, "filter-first")).toContain(`const a = ${recv}.find((x) => x > 1);`);
    }
  });
  test("assumed on other arrays: find, unlike filter, visits holes", () => {
    for (const code of [`${ARR}const a = xs.filter((x) => x > 1)[0];`, `${ARR}const a = [1, , 3].filter((x) => x > 1)[0];`]) {
      const f = run(code, { rule: "filter-first" }).findings[0]?.fix;
      expect(f).toMatchObject({ tier: "assumed", assumes: "the receiver is an array without holes" });
      expect(fixed(code, "filter-first", "assumed")).toContain(".find((x) => x > 1)");
    }
  });
  test("unsafe fix when the type is unknown", () => {
    const code = "function f(xs) { return xs.filter(Boolean)[0]; }";
    const r = run(code, { rule: "filter-first", file: "/virtual/a.js" });
    expect(r.findings[0]?.fix?.tier).toBe("assumed");
    expect(fixed(code, "filter-first", "typed", { file: "/virtual/a.js" })).toBe(code);
  });
  test("ignores non-arrays", () => {
    expect(rulesHit("declare const m: { filter(f: unknown): string[] };\nm.filter(1)[0];", { rule: "filter-first" })).toEqual([]);
  });
});

describe("filter-length-to-some", () => {
  test.each([
    ["xs.filter(f).length > 0", "xs.some(f)"],
    ["xs.filter(f).length !== 0", "xs.some(f)"],
    ["xs.filter(f).length >= 1", "xs.some(f)"],
    ["xs.filter(f).length === 0", "!xs.some(f)"],
    ["xs.filter(f).length < 1", "!xs.some(f)"],
  ])("%s", (input, out) => {
    const pre = `${ARR}declare const f: (x: number) => boolean;\n`;
    expect(fixed(`${pre}const b = ${input};`, "filter-length-to-some")).toBe(`${pre}const b = ${out};`);
  });
  test("boolean context", () => {
    expect(fixed(`${ARR}if (xs.filter(Boolean).length) {}`, "filter-length-to-some")).toBe(`${ARR}if (xs.some(Boolean)) {}`);
  });
  test("leaves counts alone", () => {
    expect(rulesHit(`${ARR}const n = xs.filter(Boolean).length;`, { rule: "filter-length-to-some" })).toEqual([]);
  });
});

describe("array method rewrites", () => {
  test("map-flat-to-flatmap", () => {
    expect(fixed(`${ARR}xs.map((x) => [x, x]).flat();`, "map-flat-to-flatmap")).toBe(`${ARR}xs.flatMap((x) => [x, x]);`);
    expect(rulesHit(`${ARR}xs.map((x) => [x]).flat(2);`, { rule: "map-flat-to-flatmap" })).toEqual([]);
  });
  test("unused-map", () => {
    expect(fixed(`${ARR}xs.map((x) => console.log(x));`, "unused-map")).toBe(`${ARR}xs.forEach((x) => console.log(x));`);
    expect(rulesHit(`${ARR}const ys = xs.map((x) => x);`, { rule: "unused-map" })).toEqual([]);
  });
  test("array-from-map", () => {
    expect(fixed("const a = Array.from(new Set([1])).map((x) => x * 2);", "array-from-map"))
      .toBe("const a = Array.from(new Set([1]), (x) => x * 2);");
  });
  test("redundant-array-copy", () => {
    // map skips holes, which the spread copy turned into undefined; find visits them either way.
    expect(fixed(`${ARR}[...xs].map((x) => x);`, "redundant-array-copy")).toBe(`${ARR}[...xs].map((x) => x);`);
    expect(run(`${ARR}[...xs].map((x) => x);`, { rule: "redundant-array-copy" }).findings[0]?.fix).toMatchObject({ tier: "assumed", assumes: "the array has no holes" });
    expect(fixed(`${ARR}[...xs].map((x) => x);`, "redundant-array-copy", "assumed")).toBe(`${ARR}xs.map((x) => x);`);
    expect(fixed(`${ARR}[...xs].find((x) => x);`, "redundant-array-copy")).toBe(`${ARR}xs.find((x) => x);`);
    expect(fixed(`${ARR}[...xs.filter(Boolean)].map((x) => x);`, "redundant-array-copy")).toBe(`${ARR}xs.filter(Boolean).map((x) => x);`);
    expect(fixed(`${ARR}xs.slice().filter(Boolean);`, "redundant-array-copy")).toBe(`${ARR}xs.filter(Boolean);`);
    expect(rulesHit(`${ARR}[...xs].sort();`, { rule: "redundant-array-copy" })).toEqual([]);
    expect(rulesHit("declare const s: Set<number>;\n[...s].map((x) => x);", { rule: "redundant-array-copy" })).toEqual([]);
  });
});

describe("report-only array rules", () => {
  test("chained-array-methods is low impact for two steps outside a loop", () => {
    const code = `${ARR}xs.map(String).join(",");\nfor (const x of xs) xs.map(String).join(",");\nxs.map(String).filter(Boolean).join(",");`;
    expect(run(code, { rule: "chained-array-methods" }).findings.map((f) => f.impact)).toEqual(["low", "medium", "medium"]);
  });
  test("chained-array-methods skips small roots and counts small loops as cold", () => {
    const code = `${ARR}const FEW = [1, 2, 3];\nFEW.map(String).filter(Boolean).join(",");\nfor (const t of FEW) xs.map(String).join(t);\nfor (const x of xs) xs.map(String).join(",");`;
    expect(run(code, { rule: "chained-array-methods" }).findings.map((f) => [f.line - 1, f.impact])).toEqual([[3, "low"], [4, "medium"]]);
  });
  test("chained-array-methods reports once per chain", () => {
    expect(rulesHit(`${ARR}xs.map((x) => x).filter(Boolean).map(String);`, { rule: "chained-array-methods" }))
      .toEqual(["chained-array-methods"]);
  });
  test("sort-for-extremum", () => {
    expect(rulesHit(`${ARR}const m = xs.sort()[0]; const n = xs.toSorted().at(-1); const o = xs.sort()[xs.length - 1];`,
      { rule: "sort-for-extremum" })).toEqual(["sort-for-extremum", "sort-for-extremum", "sort-for-extremum"]);
  });
  test("math-minmax-spread", () => {
    expect(rulesHit(`${ARR}Math.max(...xs); Math.max(1, 2);`, { rule: "math-minmax-spread" })).toEqual(["math-minmax-spread"]);
    expect(rulesHit("const ROUNDS = [3, 5, 8] as const;\nMath.max(...ROUNDS); Math.min(...[1, 2]);", { rule: "math-minmax-spread" })).toEqual([]);
  });
});

describe("typed-array-subarray", () => {
  const TA = "declare const ta: Uint8Array<ArrayBuffer>; declare const d: TextDecoder;\n";
  const tier = (code: string) => run(`${TA}${code}`, { rule: "typed-array-subarray" }).findings.map((f) => f.fix?.tier);
  test("typed when the copy is read at once", () => {
    expect(fixed(`${TA}const i = ta.slice(1, 4).indexOf(0);`, "typed-array-subarray")).toBe(`${TA}const i = ta.subarray(1, 4).indexOf(0);`);
    expect(tier("d.decode(ta.slice(2)); Math.max(...ta.slice(1)); (ta.slice(1)).includes(3);")).toEqual(["typed", "typed", "typed"]);
  });
  test("assumed when the copy is kept or user code runs while it is read", () => {
    expect(tier("const c = ta.slice(); ta.slice(1).indexOf(f()); ta.slice().forEach(() => {});\ndeclare function f(): number;"))
      .toEqual(["assumed", "assumed", "assumed"]);
    expect(fixed(`${TA}const c = ta.slice();`, "typed-array-subarray")).toBe(`${TA}const c = ta.slice();`);
  });
  test("assumed for possibly shared buffers, which TextDecoder rejects; unused copies are skipped", () => {
    const code = "declare const sab: SharedArrayBuffer; declare const any8: Uint8Array<ArrayBufferLike>; declare const d: TextDecoder;\nd.decode(new Uint8Array(sab).slice()); d.decode(any8.slice(1));\nnew Int8Array(1).slice();";
    expect(run(code, { rule: "typed-array-subarray" }).findings.map((f) => f.fix?.tier)).toEqual(["assumed", "assumed"]);
  });
  test("ignores plain arrays, Buffer-like and unknown receivers", () => {
    const code = "declare const xs: number[]; declare const u: any;\nxs.slice(1).indexOf(2); u.slice(1).indexOf(2);";
    expect(rulesHit(code, { rule: "typed-array-subarray" })).toEqual([]);
  });
});

describe("spread-in-accumulator", () => {
  test("object spread with a computed key", () => {
    const code = `${ARR}const m = xs.reduce((acc, x) => ({ ...acc, [x]: true }), {} as Record<number, boolean>);`;
    expect(fixed(code, "spread-in-accumulator"))
      .toBe(`${ARR}const m = xs.reduce((acc, x) => (acc[x] = true, acc), {} as Record<number, boolean>);`);
  });
  test("array spread in a block body", () => {
    const code = `${ARR}xs.reduce((acc: number[], x) => { if (x) return acc; return [...acc, x, x]; }, []);`;
    expect(fixed(code, "spread-in-accumulator"))
      .toBe(`${ARR}xs.reduce((acc: number[], x) => { if (x) return acc; return (acc.push(x, x), acc); }, []);`);
  });
  test("several props reading acc use Object.assign", () => {
    const code = `${ARR}xs.reduce((acc, x) => ({ ...acc, a: acc.b, b: x }), { a: 0, b: 0 });`;
    expect(fixed(code, "spread-in-accumulator")).toBe(`${ARR}xs.reduce((acc, x) => Object.assign(acc, { a: acc.b, b: x }), { a: 0, b: 0 });`);
  });
  test("non-fresh seed is left alone", () => {
    expect(rulesHit(`${ARR}declare const seed: object;\nxs.reduce((acc, x) => ({ ...acc, [x]: 1 }), seed);`,
      { rule: "spread-in-accumulator" })).toEqual([]);
  });
  test("escaping accumulator makes the fix unsafe", () => {
    const code = `${ARR}const all: object[] = [];\nxs.reduce((acc, x) => { all.push(acc); return { ...acc, [x]: 1 }; }, {});`;
    expect(run(code, { rule: "spread-in-accumulator" }).findings[0]?.fix?.tier).toBe("assumed");
  });
});

describe("accumulate-by-copy-in-loop", () => {
  test("unsafe fix to push", () => {
    const code = `${ARR}let out: number[] = [];\nfor (const x of xs) { out = [...out, x]; }`;
    expect(fixed(code, "accumulate-by-copy-in-loop", "assumed")).toBe(`${ARR}let out: number[] = [];\nfor (const x of xs) { out.push(x); }`);
  });
  test("concat reported", () => {
    expect(rulesHit(`${ARR}let out: number[] = [];\nwhile (true) { out = out.concat(xs); }`, { rule: "accumulate-by-copy-in-loop" }))
      .toEqual(["accumulate-by-copy-in-loop"]);
  });
  // From zod: a copy-on-write over two keys is neither O(n²) nor safe to make in place.
  test("skips loops over a few known items", () => {
    const code = `function f(o: Record<string, unknown>) {\n  for (const k of ["anyOf", "oneOf"] as const) o = { ...o, [k]: 1 };\n  return o;\n}`;
    expect(rulesHit(code, { rule: "accumulate-by-copy-in-loop" })).toEqual([]);
    // The same loop after for-of-to-indexed, which runs first in a multi-pass --fix.
    const indexed = `function f(o: Record<string, unknown>) {\n  const arr = ["anyOf", "oneOf"] as const;\n  for (let i = 0, len = arr.length; i < len; i++) o = { ...o, [arr[i]]: 1 };\n  return o;\n}`;
    expect(rulesHit(indexed, { rule: "accumulate-by-copy-in-loop" })).toEqual([]);
    const big = `${ARR}function f(o: Record<string, unknown>) {\n  for (let i = 0; i < xs.length; i++) o = { ...o, [i]: 1 };\n  return o;\n}`;
    expect(rulesHit(big, { rule: "accumulate-by-copy-in-loop" })).toEqual(["accumulate-by-copy-in-loop"]);
  });
  test("names the caller when the accumulator is a parameter", () => {
    const code = `${ARR}function f(o: Record<string, number>) {\n  for (const x of xs) { o = { ...o, [x]: x }; }\n  return o;\n}`;
    const [finding] = run(code, { rule: "accumulate-by-copy-in-loop" }).findings;
    expect(finding?.fix?.assumes).toContain("it is a parameter");
  });
});
