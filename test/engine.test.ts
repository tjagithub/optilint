import { describe, expect, test } from "bun:test";
import { applyFixes } from "../src/core/engine.ts";
import type { Finding } from "../src/core/types.ts";
import { rulesHit, run } from "./helpers.ts";

const ARR = "declare const xs: number[];\n";

describe("disable directives", () => {
  test("next-line with a rule list", () => {
    const code = `${ARR}// optilint-disable-next-line filter-first\nxs.filter(Boolean)[0];\nxs.filter(Boolean)[0];`;
    expect(run(code, { rule: "filter-first" }).findings.map((f) => f.line)).toEqual([4]);
  });
  test("same line, all rules", () => {
    expect(rulesHit(`${ARR}xs.filter(Boolean)[0]; // optilint-disable-line`)).toEqual([]);
  });
  test("whole file for one rule", () => {
    const code = `/* optilint-disable-file filter-first */\n${ARR}xs.filter(Boolean)[0];\nconst t = new Date().getTime();`;
    expect(rulesHit(code)).toEqual(["date-now"]);
  });
});

describe("multi-pass fixing", () => {
  test("unused map → forEach → indexed loop", () => {
    const r = run(`${ARR}xs.map((x) => console.log(x));`, { fix: "typed" });
    expect(r.output).toBe(`${ARR}for (let i = 0, len = xs.length; i < len; i++) {\n  const x = xs[i];\n  console.log(x);\n}`);
    expect(r.fixesApplied).toBe(2);
    expect(r.findings).toEqual([]);
  });
  test("nested fixes inside a converted loop are applied on a later pass", () => {
    const r = run(`${ARR}xs.forEach((x) => { if (xs.filter((y) => y > x)[0]) console.log(new Date().getTime()); });`, { fix: "typed" });
    expect(r.output).toContain("xs.find((y) => y > x)");
    expect(r.output).toContain("Date.now()");
    expect(r.output).toContain("for (let i = 0, len = xs.length;");
  });
  test("unsafe fixes wait for --fix-unsafe", () => {
    const code = "function f(a) { return a.filter(Boolean)[0]; }";
    expect(run(code, { fix: "typed", file: "/virtual/a.js" }).output).toBe(code);
    expect(run(code, { fix: "assumed", file: "/virtual/a.js" }).output).toBe("function f(a) { return a.find(Boolean); }");
  });
});

test("applyFixes skips overlapping edits", () => {
  const f = (start: number, end: number, text: string): Finding => ({
    rule: "r", group: "g", impact: "low", message: "", file: "", line: 1, col: 1, endLine: 1, endCol: 1, start, end,
    fix: { tier: "exact", edits: [{ start, end, text }] },
  });
  expect(applyFixes("abcdef", [f(0, 3, "X"), f(2, 4, "Y"), f(4, 6, "Z")])).toEqual({ text: "XdZ", applied: 2 });
});
