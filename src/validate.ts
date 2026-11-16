import { TIERS } from "./core/fix.ts";
import { allRules, groups } from "./rules/index.ts";

export const TOP_KEYS = ["$schema", "extends", "files", "ignore", "tier", "obscure", "minImpact", "rules", "overrides"];
export const LEVELS = ["off", "on", "info", "warn", "error"];
export const PRESETS = ["recommended", "all", "none"];
export const IMPACTS = ["low", "medium", "high"];
export const FLOORS = ["none", ...TIERS];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => JSON.stringify(v);

function distance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** ` (did you mean "x"?)` for the nearest option within a few edits, else "". */
export function suggest(word: string, options: readonly string[]) {
  let best: string | undefined;
  let score = Math.max(2, Math.floor(word.length / 3)) + 1;
  for (const o of options) {
    const d = distance(word, o);
    if (d < score) [best, score] = [o, d];
  }
  return best ? ` (did you mean ${show(best)}?)` : "";
}

class Errors {
  list: string[] = [];
  add(at: string, msg: string) {
    this.list.push(`${at}: ${msg}`);
  }
  oneOf(at: string, v: unknown, options: readonly string[]) {
    if (typeof v === "string" && options.includes(v)) return true;
    this.add(at, `expected one of ${options.map(show).join(", ")}, got ${show(v)}${typeof v === "string" ? suggest(v, options) : ""}`);
    return false;
  }
  strings(at: string, v: unknown) {
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) return true;
    this.add(at, "expected an array of strings");
    return false;
  }
  keys(at: string, v: Obj, allowed: readonly string[]) {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.add(at, `unknown key ${show(k)}${suggest(k, allowed)}`);
  }
}

function ruleValue(e: Errors, at: string, v: unknown) {
  if (typeof v === "string") return void e.oneOf(at, v, LEVELS);
  if (!isObj(v)) return e.add(at, `expected a level (${LEVELS.join(", ")}) or { "level": ..., "tier": ... }`);
  e.keys(at, v, ["level", "tier"]);
  if (!("level" in v)) e.add(at, `missing "level"`);
  else e.oneOf(`${at}.level`, v.level, LEVELS);
  if ("tier" in v) e.oneOf(`${at}.tier`, v.tier, FLOORS);
}

const RULE_NAMES = allRules.map((r) => r.name);

function validateRules(e: Errors, at: string, v: unknown) {
  if (!isObj(v)) return e.add(at, "expected an object");
  for (const [key, value] of Object.entries(v)) {
    const here = `${at}.${key}`;
    if (key === "preset") e.oneOf(here, value, PRESETS);
    else if (groups.includes(key)) {
      if (typeof value === "string") {
        e.oneOf(here, value, LEVELS);
        continue;
      }
      if (!isObj(value)) {
        e.add(here, "expected a level or an object of this group's rules");
        continue;
      }
      const own = allRules.filter((r) => r.group === key).map((r) => r.name);
      for (const [name, rv] of Object.entries(value)) {
        const other = allRules.find((r) => r.name === name);
        if (own.includes(name)) ruleValue(e, `${here}.${name}`, rv);
        else if (other) e.add(`${here}.${name}`, `rule is in group ${show(other.group)}, not ${show(key)}`);
        else e.add(`${here}.${name}`, `unknown rule${suggest(name, own)}`);
      }
    } else if (RULE_NAMES.includes(key)) ruleValue(e, here, value);
    else e.add(here, `unknown rule or group${suggest(key, [...RULE_NAMES, ...groups, "preset"])}`);
  }
}

/** Problems with a parsed config, as "path: message" lines; empty when it is valid. */
export function validate(raw: unknown): string[] {
  const e = new Errors();
  if (!isObj(raw)) return ["config must be a JSON object"];
  e.keys("config", raw, TOP_KEYS);
  if ("$schema" in raw && typeof raw.$schema !== "string") e.add("$schema", "expected a string");
  if ("extends" in raw) e.strings("extends", raw.extends);
  if ("ignore" in raw) e.strings("ignore", raw.ignore);
  if ("files" in raw) {
    if (!isObj(raw.files)) e.add("files", "expected an object");
    else {
      e.keys("files", raw.files, ["include", "ignore"]);
      for (const k of ["include", "ignore"]) if (k in raw.files) e.strings(`files.${k}`, raw.files[k]);
    }
  }
  if ("tier" in raw) e.oneOf("tier", raw.tier, TIERS);
  if ("obscure" in raw && typeof raw.obscure !== "boolean") e.add("obscure", "expected true or false");
  if ("minImpact" in raw) e.oneOf("minImpact", raw.minImpact, IMPACTS);
  if ("rules" in raw) validateRules(e, "rules", raw.rules);
  if ("overrides" in raw) {
    if (!Array.isArray(raw.overrides)) e.add("overrides", "expected an array");
    else raw.overrides.forEach((o, i) => {
      const at = `overrides[${i}]`;
      if (!isObj(o)) return e.add(at, "expected an object");
      e.keys(at, o, ["include", "tier", "obscure", "rules"]);
      if (!("include" in o)) e.add(at, `missing "include"`);
      else e.strings(`${at}.include`, o.include);
      if ("tier" in o) e.oneOf(`${at}.tier`, o.tier, TIERS);
      if ("obscure" in o && typeof o.obscure !== "boolean") e.add(`${at}.obscure`, "expected true or false");
      if ("rules" in o) validateRules(e, `${at}.rules`, o.rules);
    });
  }
  return e.list;
}

/** Problems with rule or group names given on the command line. */
export function validateNames(names: readonly string[]): string[] {
  const known = [...RULE_NAMES, ...groups];
  return names.filter((n) => !known.includes(n)).map((n) => `unknown rule or group ${show(n)}${suggest(n, known)}`);
}
