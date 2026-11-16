import { describe, expect, test } from "bun:test";
import { fixed, rulesHit, run } from "./helpers.ts";

const ARR = "declare const xs: number[];\n";

describe("filter-first", () => {
  test("fixes on proven arrays", () => {
    expect(fixed(`${ARR}const a = xs.filter((x) => x > 1)[0];`, "filter-first"))
      .toBe(`${ARR}const a = xs.find((x) => x > 1);`);
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
    expect(fixed(`${ARR}[...xs].map((x) => x);`, "redundant-array-copy")).toBe(`${ARR}xs.map((x) => x);`);
    expect(fixed(`${ARR}xs.slice().filter(Boolean);`, "redundant-array-copy")).toBe(`${ARR}xs.filter(Boolean);`);
    expect(rulesHit(`${ARR}[...xs].sort();`, { rule: "redundant-array-copy" })).toEqual([]);
    expect(rulesHit("declare const s: Set<number>;\n[...s].map((x) => x);", { rule: "redundant-array-copy" })).toEqual([]);
  });
});

describe("report-only array rules", () => {
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
});
