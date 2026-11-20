import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { fixed, run } from "./helpers.ts";
import { validate } from "../src/validate.ts";

const ES5_LIB = { lib: ["lib.es5.d.ts"] };
// tsc does not emit, so nothing downlevels the syntax a fix writes.
const ES5_SOURCE = { target: ts.ScriptTarget.ES5, noEmit: true };
const finding = (code: string, rule: string, opts: Parameters<typeof run>[1] = {}) => run(code, { ...opts, rule }).findings[0];

describe("a lib without the method a fix calls", () => {
  const cases: [string, string, string][] = [
    ["filter-first", "export const f = (xs: number[]) => xs.filter((x) => x > 1)[0];", "ES2015"],
    ["regex-to-string-method", "export const f = (s: string) => /^abc/.test(s);", "ES2015"],
    ["regex-to-string-method", "export const f = (s: string) => /abc$/.test(s);", "ES2015"],
    ["regex-to-string-method", "export const f = (s: string) => /abc/.test(s);", "ES2015"],
    ["indexof-to-startswith", "export const f = (s: string, t: string) => s.indexOf(t) === 0;", "ES2015"],
    ["split-join-to-replaceall", "export const f = (s: string) => s.split(',').join(';');", "ES2021"],
  ];
  for (const [rule, code, year] of cases) {
    test(`${rule}: ${code.slice(16)}`, () => {
      const f = finding(code, rule, { compilerOptions: ES5_LIB });
      expect(f?.message).toEndWith(`(Needs ${year}.)`);
      expect(f?.fix).toBeUndefined();
      expect(finding(code, rule)?.fix).toBeDefined();
    });
  }

  test("a regex that is the whole string still becomes ===", () => {
    expect(fixed("export const f = (s: string) => /^abc$/.test(s);", "regex-to-string-method", "typed", { compilerOptions: ES5_LIB }))
      .toContain('s === "abc"');
  });
});

describe("the config's target", () => {
  test("holds back methods the lib has", () => {
    const code = "export const f = (xs: number[]) => xs.filter((x) => x > 1)[0];";
    expect(finding(code, "filter-first", { target: "es5" })?.message).toEndWith("(Needs ES2015.)");
    expect(finding(code, "filter-first", { target: "es2015" })?.fix).toBeDefined();
  });

  test("holds back let/const and object spread", () => {
    const loop = "export function f(xs: number[]) { xs.forEach((x) => console.log(x)); }";
    expect(finding(loop, "foreach-to-for", { target: "es5" })?.message).toEndWith("(Needs ES2015.)");
    expect(finding(loop, "foreach-to-for", { target: "es5" })?.fix).toBeUndefined();
    const assign = "export const f = (a: object) => Object.assign({}, a);";
    expect(finding(assign, "object-assign-to-spread", { target: "es2017" })?.message).toEndWith("(Needs ES2018.)");
    expect(finding(assign, "object-assign-to-spread", { target: "es2018" })?.fix).toBeDefined();
  });

  test("keeps the comparisons of array-literal-lookup and holds back the hoisted Set", () => {
    const short = "export const f = (x: string) => ['a', 'b'].includes(x);";
    expect(fixed(short, "array-literal-lookup", "exact", { target: "es5" })).toContain("x === 'a' || x === 'b'");
    const long = "export const f = (x: string) => ['a', 'b', 'c', 'd', 'e', 'f', 'g'].includes(x.trim());";
    expect(finding(long, "array-literal-lookup", { target: "es5" })?.message).toEndWith("(Needs ES2015.)");
    expect(fixed(long, "array-literal-lookup", "exact")).toContain("new Set(");
  });

  test("holds back a regex literal with a newer flag", () => {
    const code = "export function f(s: string) { return new RegExp('a.b', 's').test(s); }";
    expect(finding(code, "regexp-constructor-literal", { target: "es2017" })?.message).toEndWith("(Needs ES2018.)");
    expect(fixed(code, "regexp-constructor-literal", "exact", { target: "es2018" })).toContain("/a.b/s");
  });

  test("is checked in optilint.json and its overrides", () => {
    expect(validate({ target: "es2020", overrides: [{ include: ["legacy/**"], target: "es5" }] })).toEqual([]);
    expect(validate({ target: "es6" }).join("\n")).toContain("es2015");
  });
});

describe("tsc's target", () => {
  const loop = "export function f(xs: number[]) { xs.forEach((x) => console.log(x)); }";

  test("limits syntax when tsc does not emit", () => {
    expect(finding(loop, "foreach-to-for", { compilerOptions: ES5_SOURCE })?.fix).toBeUndefined();
  });

  test("does not when tsc emits, since tsc downlevels it", () => {
    expect(finding(loop, "foreach-to-for", { compilerOptions: { target: ts.ScriptTarget.ES5 } })?.fix).toBeDefined();
  });

  test("limits regex flags either way, since tsc rejects newer ones", () => {
    const code = "export function f(s: string) { return new RegExp('a.b', 's').test(s); }";
    expect(finding(code, "regexp-constructor-literal", { compilerOptions: { target: ts.ScriptTarget.ES2017 } })?.fix).toBeUndefined();
  });
});
