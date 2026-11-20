import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { run } from "./helpers.ts";

const T = ts.ScriptTarget;
const hits = (code: string, rule: string, compilerOptions: ts.CompilerOptions, file?: string) =>
  run(code, { rule, compilerOptions, file }).findings.map((f) => [f.line, f.message]);

describe("downlevel-async", () => {
  const code = `declare const it: AsyncIterable<number>;
export const a = async () => 1;
export async function b() { return await a(); }
class C { async m() {} }
`;
  test("reports once per file, at the first async function, with the count", () => {
    expect(hits(code, "downlevel-async", { target: T.ES2015 })).toEqual([
      [2, "`target: ES2015` compiles 3 async functions and loops in this file to generators (2–14x slower); set `target` to ES2017 or later in tsconfig."],
    ]);
  });
  test("ES2017 still downlevels async generators and for await, which need ES2018", () => {
    const gen = `${code}export async function* g() { for await (const x of it) yield x; }\n`;
    expect(hits(gen, "downlevel-async", { target: T.ES2017 }).map(([, m]) => m)).toEqual([
      "`target: ES2017` compiles 2 async functions and loops in this file to generators (2–14x slower); set `target` to ES2018 or later in tsconfig.",
    ]);
    expect(hits(gen, "downlevel-async", { target: T.ES2018 })).toEqual([]);
  });
  test("quiet when TypeScript emits nothing, by default, and on JavaScript and declaration files", () => {
    expect(hits(code, "downlevel-async", {})).toEqual([]);
    expect(hits(code, "downlevel-async", { target: T.ES2015, noEmit: true })).toEqual([]);
    expect(hits(code, "downlevel-async", { target: T.ES2015, emitDeclarationOnly: true, declaration: true })).toEqual([]);
    expect(hits("export const a = async () => 1;", "downlevel-async", { target: T.ES2015, allowJs: true }, "/virtual/test.js")).toEqual([]);
  });
});

describe("define-class-fields", () => {
  const code = `export class P {
  static count = 0;
  declare tag: string;
  x = 0;
  y: number;
  #z = 1;
  constructor(y: number) { this.y = y; }
}
`;
  test("counts instance fields; not static, declare or #private ones", () => {
    expect(hits(code, "define-class-fields", { target: T.ES2020, useDefineForClassFields: true })).toEqual([
      [4, "`useDefineForClassFields` with `target: ES2020` emits 2 class fields in this file as `Object.defineProperty` calls (4–100x slower to construct); set `target` to ES2022 or later in tsconfig."],
    ]);
  });
  test("quiet with assignment semantics (the default below ES2022) and with native fields", () => {
    expect(hits(code, "define-class-fields", { target: T.ES2020 })).toEqual([]);
    expect(hits(code, "define-class-fields", { target: T.ES2022, useDefineForClassFields: true })).toEqual([]);
  });
});

describe("downlevel-private-fields", () => {
  const code = `export class Counter {
  #n = 0;
  private step = 1;
  #bump() { this.#n += this.step; }
  get n() { this.#bump(); return this.#n; }
}
`;
  test("counts #private fields and methods below ES2022", () => {
    expect(hits(code, "downlevel-private-fields", { target: T.ES2021 })).toEqual([
      [2, "`target: ES2021` emulates 2 `#private` members in this file with WeakMaps (5–200x+ slower); set `target` to ES2022 or later in tsconfig, or use the `private` keyword."],
    ]);
    expect(hits(code, "downlevel-private-fields", { target: T.ES2022 })).toEqual([]);
  });
});
