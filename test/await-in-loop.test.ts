import { describe, expect, test } from "bun:test";
import { run } from "./helpers.ts";

const DECLS = `declare const ids: number[]; declare function get(id: number): Promise<number>;
declare function sleep(ms: number): Promise<void>; declare function ready(): Promise<boolean>;\n`;

/** Lines (1-based, in `body`) of await-in-loop findings, with `body` inside an async function. */
function lines(body: string, opts: Parameters<typeof run>[1] = {}) {
  const code = `${DECLS}async function f() {\n${body}\n}`;
  return run(code, { rule: "await-in-loop", ...opts }).findings.map((f) => f.line - 3);
}

describe("await-in-loop", () => {
  test("one finding per loop, at its first await", () => {
    expect(lines("for (const id of ids) {\n  await get(id);\n  await get(id + 1);\n}")).toEqual([2]);
    expect(lines("for (let i = 0; i < ids.length; i++) await get(ids[i]!);")).toEqual([1]);
  });

  test("an inner loop gets its own finding; callbacks and for await do not count", () => {
    expect(lines("for (const a of ids) {\n  for (const b of ids) await get(a + b);\n}")).toEqual([2]);
    expect(lines("for (const id of ids) setTimeout(async () => { await get(id); });")).toEqual([]);
  });

  test("polling and retrying loops are left alone", () => {
    expect(lines("while (true) { if (await ready()) break; }")).toEqual([]);
    expect(lines("for (;;) { await get(1); }")).toEqual([]);
    expect(lines("while (!(await ready())) {}")).toEqual([]);
    expect(lines("let ok = false;\nwhile (!ok) ok = await ready();")).toEqual([]);
    expect(lines("let n = 0;\nwhile (n < 3) { await get(n); n++; }")).toEqual([2]);
  });

  test("paced loops are left alone", () => {
    expect(lines("for (const id of ids) { await get(id); await sleep(100); }")).toEqual([]);
    expect(lines("for (const id of ids) { await get(id); await new Promise((r) => setTimeout(r, 100)); }")).toEqual([]);
  });

  test("searches that stop early are left alone, unless the exit is an inner loop's", () => {
    expect(lines("for (const id of ids) { if (await get(id)) return id; }")).toEqual([]);
    expect(lines("for (const id of ids) { if (await get(id)) break; }")).toEqual([]);
    expect(lines("for (const id of ids) { await get(id); for (const j of ids) if (j) break; }")).toEqual([1]);
    expect(lines("for (const id of ids) { if (id) break; await get(id); }")).toEqual([1]);
  });

  test("batched loops are left alone", () => {
    expect(lines("for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map(get));")).toEqual([]);
  });

  test("loop-carried values and recursion are left alone", () => {
    expect(lines("let top = 0;\nfor (const id of ids) top = await get(top + id);")).toEqual([]);
    expect(lines("let total = 0;\nfor (const id of ids) total += await get(id);")).toEqual([2]);
    const walker = `${DECLS}async function walk(n: number): Promise<void> {\n  for (const id of ids) await walk(n + id);\n}`;
    expect(run(walker, { rule: "await-in-loop" }).findings).toEqual([]);
  });

  test("promises that are already running are left alone", () => {
    expect(lines("const ps = ids.map(get);\nfor (const p of ps) await p;")).toEqual([]);
    expect(lines("const ps = ids.map(get);\nfor (let i = 0; i < ps.length; i++) console.log(await ps[i]);")).toEqual([]);
    expect(lines("for (const id of ids) { const p = get(id); await p; }")).toEqual([1]);
  });

  test("calls that drive one stateful target in order are left alone", () => {
    const vscode = { "/virtual/vscode.d.ts": 'declare module "vscode" { export function showTextDocument(n: number): Promise<void>; }' };
    const code = `import { showTextDocument } from "vscode";\nexport async function f(ids: number[]) {\n  for (const id of ids) await showTextDocument(id);\n}`;
    expect(run(code, { rule: "await-in-loop", extra: vscode }).findings).toEqual([]);
    const page = { "/virtual/node_modules/playwright-core/types.d.ts": "declare const page: { click(s: string): Promise<void> };" };
    expect(lines("for (const id of ids) await page.click(String(id));", { extra: page })).toEqual([]);
    const local = { "/virtual/page.d.ts": "declare const page: { click(s: string): Promise<void> };" };
    expect(lines("for (const id of ids) await page.click(String(id));", { extra: local })).toEqual([1]);
  });

  test("the message says how to keep a deliberate order", () => {
    const [finding] = run(`${DECLS}async function f() { for (const id of ids) await get(id); }`, { rule: "await-in-loop" }).findings;
    expect(finding?.message).toContain("if order matters, disable this line");
  });

  test("promise chains built with reduce are flagged", () => {
    expect(lines("await ids.reduce(async (acc, id) => { await acc; await get(id); }, Promise.resolve());")).toEqual([1]);
    expect(lines("await ids.reduce((p, id) => p.then(() => get(id)), Promise.resolve(0));")).toEqual([1]);
    expect(lines("ids.reduce((sum, id) => sum + id, 0);")).toEqual([]);
    expect(lines("await ids.reduce(async (acc, id) => (await get(id)) + id, Promise.resolve(0));")).toEqual([]);
  });
});
