import { describe, expect, test } from "bun:test";
import { run } from "./helpers.ts";

/** Lines of `rule` findings in `code`. */
const lines = (code: string, rule: string) => run(code, { rule }).findings.map((f) => f.line);

describe("string-flatten-in-loop", () => {
  const R = "string-flatten-in-loop";
  test("flags a string grown and read in the same loop", () => {
    const code = `declare const parts: string[];
let s = "";
for (const p of parts) { s += p; if (s.charCodeAt(s.length - 1) === 10) {} }
let t = "";
for (const p of parts) { t += p; t[0]; }
let u = "";
for (const p of parts) { if (p) u += p; else u += "-"; u.endsWith("-"); }`;
    expect(lines(code, R)).toEqual([3, 5, 7]);
  });
  test("a read after the loop, a length read, or a non-string is fine", () => {
    const code = `declare const parts: string[];
let s = "";
for (const p of parts) { s += p; if (s.length > 9) break; }
s.indexOf("x");
let n = 0;
for (const p of parts) { n += p.length; }`;
    expect(lines(code, R)).toEqual([]);
  });
});

describe("regexp-in-loop", () => {
  const R = "regexp-in-loop";
  test("flags a pattern built from values that do not change in the loop", () => {
    const code = `declare const words: string[]; declare const term: string; declare function esc(s: string): string;
for (const w of words) new RegExp(esc(term), "i").test(w);
words.filter((w) => RegExp(term).test(w));`;
    expect(lines(code, R)).toEqual([2, 3]);
  });
  test("skips patterns that change, constant patterns, and calls without arguments", () => {
    const code = `declare const words: string[]; declare function next(): string;
let p = "a";
for (const w of words) { new RegExp(w); new RegExp("x+"); new RegExp(next()); new RegExp(p); p = w; }
for (const w of words) if (w) return new RegExp(p);`;
    expect(lines(code, R)).toEqual([]);
  });
});

describe("object-keys-in-loop", () => {
  const R = "object-keys-in-loop";
  test("flags keys of an object the loop does not change", () => {
    const code = `declare const o: Record<string, number>; declare const ids: string[];
for (let i = 0; i < Object.keys(o).length; i++) {}
for (const id of ids) if (Object.values(o).includes(1)) {}`;
    expect(lines(code, R)).toEqual([2, 3]);
  });
  test("skips objects the loop writes, deletes from, or passes on, and loop-local objects", () => {
    const code = `declare const o: Record<string, number>; declare const ids: string[]; declare function touch(x: object): void;
for (const id of ids) { Object.keys(o); o[id] = 1; }
for (const id of ids) { Object.keys(o); delete o[id]; }
for (const id of ids) { Object.entries(o); touch(o); }
for (const id of ids) { const local = { id }; Object.keys(local); }
for (const k of Object.keys(o)) {}
declare const byId: Record<string, object>;
for (const id of ids) Object.keys(byId[id]).length;`;
    expect(lines(code, R)).toEqual([]);
  });
});
