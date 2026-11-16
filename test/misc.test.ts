import { describe, expect, test } from "bun:test";
import { fixed, rulesHit, run } from "./helpers.ts";

describe("async", () => {
  test("await-in-loop", () => {
    const code = `declare const ids: number[]; declare function get(id: number): Promise<number>; declare const it: AsyncIterable<number>;
async function f() {
  for (const id of ids) await get(id);
  for await (const x of it) await get(x);
  await Promise.all(ids.map(async (id) => await get(id)));
}`;
    expect(rulesHit(code, { rule: "await-in-loop" })).toEqual(["await-in-loop"]);
  });
  test("sequential-await groups independent declarations", () => {
    const code = `declare function a(): Promise<number>; declare function b(): Promise<number>; declare function c(x: number): Promise<number>;
async function f() {
  const x = await a();
  const y = await b();
  const z = await c(x);
  return x + y + z;
}`;
    const r = run(code, { rule: "sequential-await" });
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]?.fix?.tier).toBe("assumed");
    expect(fixed(code, "sequential-await", "assumed")).toContain(
      "  const [x, y] = await Promise.all([\n    a(),\n    b(),\n  ]);\n  const z = await c(x);",
    );
  });
});

describe("date-now", () => {
  test.each(["new Date().getTime()", "+new Date()", "new Date().valueOf()", "Number(new Date())", "new Date.getTime()"])("%s", (input) => {
    const out = fixed(`const t = ${input};`, "date-now");
    if (input === "new Date.getTime()") expect(out).toBe(`const t = ${input};`);
    else expect(out).toBe("const t = Date.now();");
  });
  test("dates with arguments are kept", () => {
    expect(rulesHit("const t = new Date(0).getTime();", { rule: "date-now" })).toEqual([]);
  });
});

describe("math", () => {
  test("math-pow-to-mul", () => {
    const pre = "declare const x: number;\n";
    expect(fixed(`${pre}const a = Math.pow(x, 2) + 1;`, "math-pow-to-mul")).toBe(`${pre}const a = x * x + 1;`);
    expect(fixed(`${pre}const a = x ** 2 / 3;`, "math-pow-to-mul")).toBe(`${pre}const a = x * x / 3;`);
    expect(rulesHit(`${pre}Math.pow(x, 3);`, { rule: "math-pow-to-mul" })).toEqual([]);
  });
  test("bitwise-trunc is unsafe only", () => {
    const pre = "declare const x: number;\n";
    expect(fixed(`${pre}const a = Math.trunc(x / 2);`, "bitwise-trunc")).toBe(`${pre}const a = Math.trunc(x / 2);`);
    expect(fixed(`${pre}const a = Math.trunc(x / 2);`, "bitwise-trunc", "assumed")).toBe(`${pre}const a = (x / 2) | 0;`);
    expect(fixed(`${pre}const a = Math.floor(x) * 2;`, "bitwise-trunc", "assumed")).toBe(`${pre}const a = (x | 0) * 2;`);
    expect(fixed(`${pre}declare const xs: number[];\nxs[Math.floor(x * 3)];`, "bitwise-trunc", "assumed"))
      .toBe(`${pre}declare const xs: number[];\nxs[(x * 3) | 0];`);
  });
  test("bitwise-trunc skips timestamps (int32 overflows)", () => {
    expect(rulesHit("declare const d: Date;\nMath.floor(d.getTime() / 1000); Math.floor(Date.now() / 60);", { rule: "bitwise-trunc" })).toEqual([]);
  });
});

describe("environment", () => {
  test("dynamic-code", () => {
    expect(rulesHit("eval('1'); new Function('return 1'); Function('x');", { rule: "dynamic-code", file: "/virtual/a.js" }))
      .toEqual(["dynamic-code", "dynamic-code", "dynamic-code"]);
  });
  test("dom-in-loop", () => {
    const code = `declare const els: HTMLElement[];
for (const el of els) {
  document.querySelector(".x");
  el.style.height = el.offsetHeight + "px";
}
const h = document.body.offsetHeight;`;
    expect(rulesHit(code, { rule: "dom-in-loop" })).toEqual(["dom-in-loop", "dom-in-loop"]);
  });
  test("arguments-object", () => {
    expect(rulesHit("function f() { return arguments.length; }\nfunction g(arguments2: number) { return arguments2; }", {
      rule: "arguments-object", file: "/virtual/a.js",
    })).toEqual(["arguments-object"]);
  });
});
