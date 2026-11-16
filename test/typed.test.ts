import { describe, expect, test } from "bun:test";
import { fixed, run } from "./helpers.ts";

const TA = "declare const ta: Uint8Array; declare const f: Float32Array; declare const xs: number[];\n";
const lines = (code: string, rule: string) => run(`${TA}${code}`, { rule }).findings.map((x) => x.line - 1);

describe("typed-array-round-trip", () => {
  const R = "typed-array-round-trip";
  test("passes the typed array to the constructor directly", () => {
    expect(fixed(`${TA}const a = new Uint8Array(Array.from(f));`, R)).toBe(`${TA}const a = new Uint8Array(f);`);
    expect(fixed(`${TA}const a = new Int32Array([...ta]);`, R)).toBe(`${TA}const a = new Int32Array(ta);`);
  });
  test("skips plain arrays and mapped copies", () => {
    expect(lines("new Uint8Array(Array.from(xs)); new Uint8Array([...xs]); new Uint8Array(Array.from(ta, (x) => x * 2));", R)).toEqual([]);
  });
});

describe("postmessage-transfer", () => {
  const R = "postmessage-transfer";
  test("flags buffers posted without a transfer list", () => {
    const code = `declare const w: Worker; declare const ab: ArrayBuffer;
w.postMessage(ta);
w.postMessage(ab);
window.postMessage(ta, "*");`;
    expect(lines(code, R)).toEqual([2, 3, 4]);
    expect(run(`${TA}declare const w: Worker;\nw.postMessage(ta);`, { rule: R }).findings[0]?.message).toContain("[ta.buffer]");
  });
  test("skips messages with a transfer list and non-buffer data", () => {
    const code = `declare const w: Worker;
w.postMessage(ta, [ta.buffer]);
w.postMessage({ ta });
w.postMessage("hi");
window.postMessage(ta, "*", [ta.buffer]);`;
    expect(lines(code, R)).toEqual([]);
  });
});
