import type { Rule, RuleDef } from "../core/types.ts";
import { accumulateRules } from "./shared/accumulate.ts";
import { arrayRules } from "./shared/arrays.ts";
import { asyncRules } from "./shared/async.ts";
import { forEachToFor } from "./shared/foreach.ts";
import { indexedRules } from "./shared/indexed.ts";
import { lookupRules } from "./shared/lookup.ts";
import { domInLoop } from "./browser/dom.ts";
import { argumentsObject, bitwiseTrunc, dateNow, dynamicCode, powToMul } from "./shared/misc.ts";
import { objectRules } from "./shared/objects.ts";
import { stringRules } from "./shared/strings.ts";
import { postMessageTransfer, typedArrayRoundTrip, typedArraySubarray } from "./shared/typed.ts";
import { objectKeysInLoop, regexpInLoop, stringFlattenInLoop } from "./shared/invariant.ts";
import { shapeRules } from "./shared/shapes.ts";
import { passiveListener, scrollLayoutRead } from "./browser/events.ts";
import { gpuSyncInFrame, perFrameAllocation } from "./browser/frames.ts";

// Group names share the config namespace with rule names, so none may equal a rule name.
const GROUPS: Record<string, readonly RuleDef[]> = {
  accumulate: accumulateRules,
  lookup: lookupRules,
  async: asyncRules,
  arrays: [...arrayRules, typedArraySubarray, typedArrayRoundTrip],
  loops: [forEachToFor, ...indexedRules],
  strings: [...stringRules, stringFlattenInLoop, regexpInLoop],
  objects: [...objectRules, objectKeysInLoop, ...shapeRules],
  misc: [
    dateNow, powToMul, bitwiseTrunc, dynamicCode, domInLoop, argumentsObject, postMessageTransfer,
    passiveListener, scrollLayoutRead, gpuSyncInFrame, perFrameAllocation,
  ],
};

const registered: readonly Rule[] = Object.entries(GROUPS).flatMap(([group, rules]) => rules.map((r) => ({ ...r, group })));
/** The rules that can run. Retired rules are left out of presets, config, schema and output. */
export const allRules: readonly Rule[] = registered.filter((r) => !r.retired);
export const retiredRules: readonly Rule[] = registered.filter((r) => r.retired);
export const groups: readonly string[] = Object.keys(GROUPS);
export const ruleByName = new Map(allRules.map((r) => [r.name, r]));
export const retiredByName = new Map(retiredRules.map((r) => [r.name, r]));
