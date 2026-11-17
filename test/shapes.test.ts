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
  test("fields set by a method the constructor calls are fine", () => {
    const code = "class D {\n  constructor() { this.init(); }\n  init() { this.hull = []; }\n  update() { this.hull = [1]; }\n}";
    expect(lines(code, R)).toEqual([]);
  });
  test("a JS field set in the base constructor is fine", () => {
    const code = "class Base { constructor() { this.meta = undefined; } }\nclass M extends Base {\n  constructor() { super(); }\n  build() { this.meta = {}; this.extra = 1; }\n}";
    expect(lines(code, R)).toEqual([4]);
  });
  test("a class whose base cannot be resolved is skipped", () => {
    const code = "const Base = require(\"./base\");\nclass M extends Base {\n  constructor() { super(); }\n  build() { this.buildMeta = {}; }\n}";
    expect(lines(code, R)).toEqual([]);
  });
  test("a field declared on a base class is fine", () => {
    const code = "class A { protected log?: string; }\nclass B extends A {\n  constructor() { super(); }\n  set(l: string) { this.log = l; }\n}";
    expect(lines(code, R, "/virtual/a.ts")).toEqual([]);
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
  test("class setup is fine: constructors, prototypes, inheritance helpers", () => {
    const code = `function Base() {} function Child() {}
Object.setPrototypeOf(Child, Base);
Object.setPrototypeOf(Child.prototype, Base.prototype);
function _inheritsLoose(a, b) { a.__proto__ = b; }`;
    expect(lines(code, R)).toEqual([]);
  });
  test("the Error subclass idiom and literal __proto__ are fine", () => {
    const code = `class MyError extends Error { constructor(m) { super(m); Object.setPrototypeOf(this, MyError.prototype); } }
const o = { __proto__: null };`;
    expect(lines(code, R)).toEqual([]);
  });
});
