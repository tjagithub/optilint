import { ES_TARGETS } from "./core/es.ts";
import { TIERS } from "./core/fix.ts";
import { allRules, DOMAINS, groups, retiredByName, ruleByName } from "./rules/index.ts";
import { parseSlowdown } from "./slowdown.ts";

export const LEVELS = ["off", "on", "info", "warn", "error"];
export const PRESETS = ["recommended", "all", "none"];
export const IMPACTS = ["low", "medium", "high"];
export const FLOORS = ["none", ...TIERS];
export const DOMAIN_LEVELS = ["auto", "on", "off"];

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
    const known = new Set(allowed);
    for (const k of Object.keys(v)) if (!known.has(k)) this.add(at, `unknown key ${show(k)}${suggest(k, allowed)}`);
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
const NAMES_BY_GROUP = new Map(groups.map((g) => [g, allRules.filter((r) => r.group === g).map((r) => r.name)]));
const retired = (name: string) => retiredByName.get(name)?.retired;

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
      const own = NAMES_BY_GROUP.get(key)!;
      for (const [name, rv] of Object.entries(value)) {
        const other = ruleByName.get(name);
        if (other?.group === key) ruleValue(e, `${here}.${name}`, rv);
        else if (other) e.add(`${here}.${name}`, `rule is in group ${show(other.group)}, not ${show(key)}`);
        else if (retired(name)) e.add(`${here}.${name}`, `rule is retired: ${retired(name)}`);
        else e.add(`${here}.${name}`, `unknown rule${suggest(name, own)}`);
      }
    } else if (ruleByName.has(key)) ruleValue(e, here, value);
    else if (retired(key)) e.add(here, `rule is retired: ${retired(key)}`);
    else e.add(here, `unknown rule or group${suggest(key, [...RULE_NAMES, ...groups, "preset"])}`);
  }
}

/** Checks one value; `at` is its path, for messages. */
type Check = (e: Errors, at: string, v: unknown) => void;

/** Runs the check of each key of `v`; a key without one is unknown. `prefix` starts each key's path. */
function checkObject(e: Errors, at: string, v: unknown, checks: Record<string, Check>, prefix = `${at}.`) {
  if (!isObj(v)) return e.add(at, "expected an object");
  for (const [k, x] of Object.entries(v)) {
    const check = checks[k];
    if (check) check(e, `${prefix}${k}`, x);
    else e.add(at, `unknown key ${show(k)}${suggest(k, Object.keys(checks))}`); // optilint-disable-line object-keys-in-loop -- error path only
  }
}

const strings: Check = (e, at, v) => void e.strings(at, v);
const tier: Check = (e, at, v) => void e.oneOf(at, v, TIERS);
const obscure: Check = (e, at, v) => typeof v === "boolean" || e.add(at, "expected true or false");
const rules: Check = validateRules;
const domainLevel: Check = (e, at, v) => void e.oneOf(at, v, DOMAIN_LEVELS);
const target: Check = (e, at, v) => void e.oneOf(at, v, ES_TARGETS);
const OVERRIDE: Record<string, Check> = { include: strings, tier, obscure, target, rules };

// One entry per config key: adding a key means adding its check here (and to schema.ts).
const CONFIG: Record<string, Check> = {
  $schema: (e, at, v) => typeof v === "string" || e.add(at, "expected a string"),
  extends: strings,
  files: (e, at, v) => checkObject(e, at, v, { include: strings, ignore: strings }),
  ignore: strings,
  tier,
  obscure,
  target,
  minImpact: (e, at, v) => void e.oneOf(at, v, IMPACTS),
  maxSlowdown: (e, at, v) => parseSlowdown(v) !== undefined || e.add(at, `expected a percentage such as "10%", or "any", got ${show(v)}`),
  domains: (e, at, v) => checkObject(e, at, v, Object.fromEntries(Object.keys(DOMAINS).map((d) => [d, domainLevel]))),
  rules,
  overrides: (e, at, v) => {
    if (!Array.isArray(v)) return e.add(at, "expected an array");
    for (let i = 0; i < v.length; i++) {
      const o: unknown = v[i];
      if (isObj(o) && !("include" in o)) e.add(`${at}[${i}]`, `missing "include"`);
      checkObject(e, `${at}[${i}]`, o, OVERRIDE);
    }
  },
};
export const TOP_KEYS = Object.keys(CONFIG);

/** Problems with a parsed config, as "path: message" lines; empty when it is valid. */
export function validate(raw: unknown): string[] {
  if (!isObj(raw)) return ["config must be a JSON object"];
  const e = new Errors();
  checkObject(e, "config", raw, CONFIG, "");
  return e.list;
}

/** Problems with rule or group names given on the command line. */
export function validateNames(names: readonly string[]): string[] {
  const known = [...RULE_NAMES, ...groups];
  const knownSet = new Set(known);
  return names.filter((n) => !knownSet.has(n))
    .map((n) => (retired(n) ? `${show(n)} is retired: ${retired(n)}` : `unknown rule or group ${show(n)}${suggest(n, known)}`));
}
