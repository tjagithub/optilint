import { describe, expect, test } from "bun:test";
import { run } from "./helpers.ts";

const lines = (code: string, rule: string, file = "/virtual/a.js") => run(code, { rule, file }).findings.map((f) => f.line);

describe("late-property", () => {
  const R = "late-property";
  test("flags a field first added in a method, once per name", () => {
    const code = `class Cache {
  constructor() { this.size = 0; }
  load() { this.items = []; this.size = 1; }
  reset() { this.items = []; const f = () => { this.extra = 1; }; }
}`;
    expect(lines(code, R)).toEqual([3, 4]);
  });
  test("declared fields, constructor or parameter properties, statics and inherited fields are fine", () => {
    const ts = `class A {
  x = 0;
  constructor(private y: number) { this.z = 1; }
  z: number;
  set() { this.x = 1; this.y = 2; this.z = 3; }
  static make() { this.made = true; }
  static made: boolean;
}
class B extends A { more() { this.x = 2; } }`;
    expect(lines(ts, R, "/virtual/a.ts")).toEqual([]);
  });
});

describe("prototype-mutation", () => {
  const R = "prototype-mutation";
  test("flags setPrototypeOf and __proto__ assignment", () => {
    const code = `const proto = {}; const o = {};
Object.setPrototypeOf(o, proto);
Reflect.setPrototypeOf(o, null);
o.__proto__ = proto;
Object.setPrototypeOf({ a: 1 }, proto);`;
    expect(lines(code, R)).toEqual([2, 3, 4, 5]);
  });
  test("the Error subclass idiom and literal __proto__ are fine", () => {
    const code = `class MyError extends Error { constructor(m) { super(m); Object.setPrototypeOf(this, MyError.prototype); } }
const o = { __proto__: null };`;
    expect(lines(code, R)).toEqual([]);
  });
});
