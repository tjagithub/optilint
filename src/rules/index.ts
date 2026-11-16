import type { Rule, RuleDef } from "../types.ts";
import { accumulateRules } from "./accumulate.ts";
import { arrayRules } from "./arrays.ts";
import { asyncRules } from "./async.ts";
import { forEachToFor } from "./foreach.ts";
import { indexedRules } from "./indexed.ts";
import { lookupRules } from "./lookup.ts";
import { miscRules } from "./misc.ts";
import { objectRules } from "./objects.ts";
import { stringRules } from "./strings.ts";

// Group names share the config namespace with rule names, so none may equal a rule name.
const GROUPS: Record<string, readonly RuleDef[]> = {
  accumulate: accumulateRules,
  lookup: lookupRules,
  async: asyncRules,
  arrays: arrayRules,
  loops: [forEachToFor, ...indexedRules],
  strings: stringRules,
  objects: objectRules,
  misc: miscRules,
};

export const allRules: readonly Rule[] = Object.entries(GROUPS).flatMap(([group, rules]) => rules.map((r) => ({ ...r, group })));
export const groups: readonly string[] = Object.keys(GROUPS);
export const ruleByName = new Map(allRules.map((r) => [r.name, r]));
