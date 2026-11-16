import { expect, test } from "bun:test";
import { run } from "./helpers.ts";

/** Each program returns a value; after all safe fixes it must return the same value. */
const PROGRAMS: Record<string, string> = {
  "foreach with returns": `
    const xs = [3, -1, 4, -1, 5]; const out = [];
    xs.forEach((x, i) => { if (x < 0) return; switch (x) { case 4: return; default: out.push(x * i); } });
    return out;`,
  "foreach skips holes but not explicit undefined": `
    const xs = [1, , 3, undefined]; const out = [];
    xs.forEach((x, i) => { out.push([i, x]); });
    const ys = new Array(3); ys[1] = "b"; const seen = [];
    ys.forEach(([c]) => { seen.push(c); });
    return [out, seen];`,
  "for-of with closures": `
    const xs = [1, 2, 3]; const fns = [];
    for (const x of xs) fns.push(() => x);
    return fns.map((f) => f());`,
  "reduce with spread accumulators": `
    const xs = ["a", "b", "a", "c"];
    const counts = xs.reduce((acc, x) => ({ ...acc, [x]: (acc[x] || 0) + 1 }), {});
    const pairs = xs.reduce((acc, x, i) => [...acc, x + i], []);
    const swap = xs.reduce((acc, x) => ({ ...acc, a: acc.b, b: x }), { a: "", b: "" });
    return [counts, pairs, swap];`,
  "array method chains": `
    const xs = [5, 1, 4, 2, 3];
    return [
      xs.filter((x) => x > 2)[0], xs.filter((x) => x > 9).length > 0, xs.filter((x) => x > 4).length === 0,
      xs.map((x) => [x, -x]).flat(), Array.from(new Set(xs)).map((x) => x * 2), [...xs].map((x) => x + 1),
    ];`,
  "string rewrites": `
    const s = "foo-bar-baz";
    return [
      s.split("-").join("_"), /^foo/.test(s), /baz$/.test(s), /r-b/.test(s), /^foo-bar-baz$/.test(s),
      s.indexOf("foo") === 0, s.indexOf("bar") !== 0, !!s.match(/a/g), s.search(/z/) !== -1,
      new RegExp("a/b", "g").source,
    ];`,
  "object rewrites": `
    const a = { x: 1 }, b = { y: 2 }; const o = { p: 1, q: 2 }; const vals = []; const keys = [];
    for (const [, v] of Object.entries(o)) vals.push(v);
    for (const [k] of Object.entries(o)) keys.push(k);
    return [Object.assign({}, a, b), Object.assign({ z: 0 }, a), vals, keys];`,
  "literal lookups and math": `
    const kinds = ["a", "x", "c"]; const n = 7;
    function small(k) { return ["a", "b", "c"].includes(k); }
    function big(k) { return ["a", "b", "c", "d", "e", "f", "g"].includes(k); }
    return [kinds.map(small), kinds.map(big), Math.pow(n, 2) + 1, n ** 2 / 3];`,
  "cached length loop": `
    const xs = [1, 2, 3, 4]; let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[i] * 2;
    return s;`,
};

for (const [name, body] of Object.entries(PROGRAMS)) {
  test(name, () => {
    const code = `function main() {${body}\n}`;
    const r = run(code, { fix: "typed", file: "/virtual/prog.js" });
    expect(r.fixesApplied).toBeGreaterThan(0);
    const evaluate = (src: string) => new Function(`${src}\nreturn main();`)();
    expect(evaluate(r.output)).toEqual(evaluate(code));
  });
}
