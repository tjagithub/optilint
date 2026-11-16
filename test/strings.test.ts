import { describe, expect, test } from "bun:test";
import { fixed, rulesHit, run } from "./helpers.ts";

const S = "declare const s: string;\n";

describe("split-join-to-replaceall", () => {
  test("literal separator and replacement", () => {
    expect(fixed(`${S}const t = s.split("-").join("_");`, "split-join-to-replaceall")).toBe(`${S}const t = s.replaceAll("-", "_");`);
    expect(fixed(`${S}const t = s.split("-").join();`, "split-join-to-replaceall")).toBe(`${S}const t = s.replaceAll("-", ",");`);
  });
  test("$ in the replacement or empty separator is not auto-fixed", () => {
    expect(fixed(`${S}s.split("-").join("$&");`, "split-join-to-replaceall")).toBe(`${S}s.split("-").join("$&");`);
    expect(rulesHit(`${S}s.split("").join("-");`, { rule: "split-join-to-replaceall" })).toEqual([]);
  });
});

describe("regex-to-string-method", () => {
  test.each([
    ["/^foo/.test(s)", 's.startsWith("foo")'],
    ["/bar$/.test(s)", 's.endsWith("bar")'],
    ["/a\\.b/.test(s)", 's.includes("a.b")'],
    ["/^exact$/.test(s)", 's === "exact"'],
  ])("%s", (input, out) => {
    expect(fixed(`${S}const r = ${input};`, "regex-to-string-method")).toBe(`${S}const r = ${out};`);
  });
  test.each(["/^a/i", "/a+/", "/^a/m", "/\\d/", "/a|b/"])("leaves %s", (re) => {
    expect(rulesHit(`${S}${re}.test(s);`, { rule: "regex-to-string-method" })).toEqual([]);
  });
  test("single-quote files get single quotes", () => {
    expect(fixed("declare const s: string;\nconst q = 'x';\nif (/^it's/.test(s)) {}", "regex-to-string-method"))
      .toBe("declare const s: string;\nconst q = 'x';\nif (s.startsWith('it\\'s')) {}");
  });
});

describe("match-to-test", () => {
  test("match with a literal in a condition", () => {
    expect(fixed(`${S}if (s.match(/a+/g)) {}`, "match-to-test")).toBe(`${S}if (/a+/g.test(s)) {}`);
  });
  test("match with a const regex without g", () => {
    const pre = `${S}const RE = /x/;\n`;
    expect(fixed(`${pre}const ok = !s.match(RE);`, "match-to-test")).toBe(`${pre}const ok = !RE.test(s);`);
  });
  test("global const regex is left alone (test is stateful)", () => {
    expect(rulesHit(`${S}const RE = /x/g;\nif (s.match(RE)) {}`, { rule: "match-to-test" })).toEqual([]);
  });
  test("exec and search", () => {
    const pre = `${S}declare const re: RegExp;\n`;
    expect(fixed(`${pre}if (re.exec(s)) {}`, "match-to-test")).toBe(`${pre}if (re.test(s)) {}`);
    expect(fixed(`${S}const a = s.search(/z/) !== -1;`, "match-to-test")).toBe(`${S}const a = /z/.test(s);`);
    expect(fixed(`${S}const a = s.search(/z/) === -1;`, "match-to-test")).toBe(`${S}const a = !/z/.test(s);`);
  });
  test("value use is not boolean context", () => {
    expect(rulesHit(`${S}const m = s.match(/a/) || [];`, { rule: "match-to-test" })).toEqual([]);
  });
});

describe("indexof-to-startswith", () => {
  test("strings", () => {
    expect(fixed(`${S}const a = s.indexOf("x") === 0;`, "indexof-to-startswith")).toBe(`${S}const a = s.startsWith("x");`);
    expect(fixed(`${S}const a = 0 !== s.indexOf("x");`, "indexof-to-startswith")).toBe(`${S}const a = !s.startsWith("x");`);
  });
  test("arrays are left alone", () => {
    expect(rulesHit("declare const a: string[];\na.indexOf('x') === 0;", { rule: "indexof-to-startswith" })).toEqual([]);
  });
});

describe("regexp-constructor-literal", () => {
  test("constant constructor inside a function", () => {
    expect(fixed('function f() { return new RegExp("a/b\\\\d+", "gi"); }', "regexp-constructor-literal"))
      .toBe("function f() { return /a\\/b\\d+/gi; }");
  });
  test("invalid or dynamic patterns are skipped", () => {
    expect(rulesHit('function f(x: string) { new RegExp(x); new RegExp("("); }', { rule: "regexp-constructor-literal" })).toEqual([]);
  });
});

describe("catastrophic-regex", () => {
  test.each(["/(a+)+$/", "/^(\\w+\\s?)*$/", "/(?:[a-z]*)*x/", "/(\\d{1,})+/"])("flags %s", (re) => {
    expect(rulesHit(`const r = ${re};`, { rule: "catastrophic-regex" })).toEqual(["catastrophic-regex"]);
  });
  test.each(["/(\\s*,\\s*\\w+)*/", "/(ab)+/", "/(a|b)+/", "/(\\d+)?/", "/[(a+)+]/"])("allows %s", (re) => {
    expect(rulesHit(`const r = ${re};`, { rule: "catastrophic-regex" })).toEqual([]);
  });
});

test("JS files: unknown string types get unsafe fixes", () => {
  const r = run("function f(s) { return /^a/.test(s); }", { rule: "regex-to-string-method", file: "/virtual/a.js" });
  expect(r.findings[0]?.fix?.tier).toBe("assumed");
});
