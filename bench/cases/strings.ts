import { type Case, lines, SIZES } from "../case.ts";

// Each case checks every line of a list, mostly misses (see `lines`).
const count = (test: string) => `export function run(xs: string[]) { let n = 0; for (const s of xs) if (${test}) n++; return n; }`;

export const cases: Case[] = [
  {
    rule: "split-join-to-replaceall", sizes: SIZES, inputs: lines,
    code: `export function run(xs: string[]) { let n = 0; for (const s of xs) n += s.split(" ").join("_").length; return n; }`,
  },
  { rule: "regex-to-string-method", sizes: SIZES, inputs: lines, code: count(`/needle/.test(s)`) },
  { rule: "match-to-test", sizes: SIZES, inputs: lines, code: count(`s.match(/\\d@x/)`) },
  { rule: "indexof-to-startswith", sizes: SIZES, inputs: lines, code: count(`s.indexOf("http") === 0`) },
  { rule: "regexp-constructor-literal", sizes: SIZES, inputs: lines, code: count(`new RegExp("^http://\\\\w+/").test(s)`) },
];
