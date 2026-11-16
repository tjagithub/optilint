import { describe, expect, test } from "bun:test";
import { fixed, rulesHit, run } from "./helpers.ts";

describe("object-assign-to-spread", () => {
  test("basic and with target properties", () => {
    const pre = "declare const a: object, b: object;\n";
    expect(fixed(`${pre}const c = Object.assign({}, a, b);`, "object-assign-to-spread")).toBe(`${pre}const c = { ...a, ...b };`);
    expect(fixed(`${pre}const c = Object.assign({ x: 1 }, a);`, "object-assign-to-spread")).toBe(`${pre}const c = { x: 1, ...a };`);
  });
  test("arrow body gets parens", () => {
    expect(fixed("const f = (a: object) => Object.assign({}, a);", "object-assign-to-spread")).toBe("const f = (a: object) => ({ ...a });");
  });
  test("non-literal target is a real mutation", () => {
    expect(rulesHit("declare const t: object, a: object;\nObject.assign(t, a);", { rule: "object-assign-to-spread" })).toEqual([]);
  });
});

describe("object-entries-iteration", () => {
  const pre = "declare const o: Record<string, number>;\n";
  test("value only → Object.values (safe)", () => {
    expect(fixed(`${pre}for (const [, v] of Object.entries(o)) console.log(v);`, "object-entries-iteration"))
      .toBe(`${pre}for (const v of Object.values(o)) console.log(v);`);
  });
  test("key only → Object.keys (safe)", () => {
    expect(fixed(`${pre}for (const [k] of Object.entries(o)) console.log(k);`, "object-entries-iteration"))
      .toBe(`${pre}for (const k of Object.keys(o)) console.log(k);`);
  });
  test("key and value → keys + lookup (unsafe)", () => {
    const code = `${pre}for (const [k, v] of Object.entries(o)) {\n  console.log(k, v);\n}`;
    expect(run(code, { rule: "object-entries-iteration" }).findings[0]?.fix?.tier).toBe("assumed");
    expect(fixed(code, "object-entries-iteration", "assumed"))
      .toBe(`${pre}for (const k of Object.keys(o)) {\n  const v = o[k];\n  console.log(k, v);\n}`);
  });
  test("a cast receiver keeps its parentheses, and the assumption names the object", () => {
    const code = `function main() {\n  const o: unknown = { a: 1, b: 2 };\n  const out: string[] = [];\n  for (const [k, v] of Object.entries(o as Record<string, number>)) out.push(k + v);\n  return out;\n}`;
    const out = fixed(code, "object-entries-iteration", "assumed");
    expect(out).toContain("const v = (o as Record<string, number>)[k];");
    expect(run(code, { rule: "object-entries-iteration" }).findings[0]?.fix?.assumes).toBe("the loop does not write to `o` or rely on getters running up front");
    const evaluate = (src: string) => new Function(`${new Bun.Transpiler({ loader: "ts" }).transformSync(src)}\nreturn main();`)();
    expect(evaluate(out)).toEqual(["a1", "b2"]);
    expect(evaluate(out)).toEqual(evaluate(code));
  });
});

describe("report-only object rules", () => {
  test("delete-property", () => {
    expect(rulesHit("const o: { a?: number } = {};\ndelete o.a;", { rule: "delete-property" })).toEqual(["delete-property"]);
  });
  test("object-keys-emptiness", () => {
    const code = "declare const o: object;\nif (Object.keys(o).length === 0) {}\nif (!Object.keys(o).length) {}\nconst n = Object.keys(o).length;";
    expect(rulesHit(code, { rule: "object-keys-emptiness" })).toEqual(["object-keys-emptiness", "object-keys-emptiness"]);
  });
});

describe("large-object-literal", () => {
  const big = `[${Array.from({ length: 1500 }, (_, i) => `{ id: ${i}, name: "n${i}" }`).join(", ")}]`;
  test("JS: safe JSON.parse fix that round-trips", () => {
    const out = fixed(`const data = ${big};`, "large-object-literal", "typed", { file: "/virtual/a.js" });
    expect(out.startsWith("const data = JSON.parse(")).toBe(true);
    const value = new Function(`${out}; return data;`)();
    expect(value).toEqual(new Function(`return ${big};`)());
  });
  test("TS: unsafe (type is lost)", () => {
    expect(run(`const data = ${big};`, { rule: "large-object-literal" }).findings[0]?.fix?.tier).toBe("assumed");
  });
  test("non-JSON values are skipped", () => {
    const code = `const data = [${Array.from({ length: 2000 }, () => "undefined").join(", ")}];`;
    expect(rulesHit(code, { rule: "large-object-literal" })).toEqual([]);
  });
});
