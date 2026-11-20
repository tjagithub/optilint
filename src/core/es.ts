import ts from "typescript";

/** The ES versions the `target` setting accepts. */
export const ES_TARGETS = [
  "es5", "es2015", "es2016", "es2017", "es2018", "es2019", "es2020", "es2021", "es2022", "es2023", "es2024", "es2025", "esnext",
] as const;
export type EsTarget = (typeof ES_TARGETS)[number];

/** A target as a year: es5 → 5, es2015 → 2015, esnext → Infinity. */
export const esYear = (t: EsTarget) => (t === "es5" ? 5 : t === "esnext" ? Infinity : Number(t.slice(2)));

/** tsc's `target` as a year; ES3 counts as ES5. */
export function scriptTargetYear(t: ts.ScriptTarget | undefined) {
  if (t === undefined || t >= ts.ScriptTarget.ESNext) return Infinity;
  return t <= ts.ScriptTarget.ES5 ? 5 : 2013 + t;
}

/** The syntax and globals that fixes write, by the ES version that added them. */
export const FEATURES = { "let-const": 2015, "object-spread": 2018, Set: 2015 } as const;
export type EsFeature = keyof typeof FEATURES;

/** Methods that fixes call, by the ES version that added them; `hasMember` checks these against the target. */
export const METHODS: Readonly<Record<string, number>> = {
  find: 2015, startsWith: 2015, endsWith: 2015, includes: 2015, flatMap: 2019, replaceAll: 2021,
};

/** Regex flags by the ES version that added them; tsc rejects a literal with a newer flag than its target. */
export const REGEX_FLAGS: Readonly<Record<string, number>> = { y: 2015, u: 2015, s: 2018, d: 2022, v: 2024 };

/** The note a finding gets when its fix needs a newer ES version than the file allows. */
export const needs = (year: number) => `(Needs ES${year}.)`;
