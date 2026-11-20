import type { Engine, Rule } from "./core/types.ts";
import { SPEEDUPS } from "./speedups.ts";

export type { Engine };

/** The engine each `targets` entry runs on: it decides which bench results count. */
export const TARGETS = { node: "v8", deno: "v8", chrome: "v8", edge: "v8", bun: "jsc", safari: "jsc" } as const satisfies Record<string, Engine>;
export type Target = keyof typeof TARGETS;
export const ENGINES: readonly Engine[] = ["v8", "jsc"];

/** The engines `targets` run on; every engine when unset or empty. */
export const enginesOf = (targets?: readonly Target[]): readonly Engine[] =>
  targets?.length ? [...new Set(targets.map((t) => TARGETS[t]))] : ENGINES;

/** Fixes may measure up to this much slower on some tier: bench noise, not a real loss. */
export const DEFAULT_MAX_SLOWDOWN = "10%";

/** `"10%"` → 0.1 and `"any"` → Infinity; undefined for anything else. */
export function parseSlowdown(v: unknown): number | undefined {
  if (v === "any") return Infinity;
  const m = typeof v === "string" ? /^(\d+(?:\.\d+)?)%$/.exec(v) : null;
  return m ? Number(m[1]) / 100 : undefined;
}

/** How much slower a rule's fix measured at worst (0.34: 34% slower); 0 when never slower, undefined when not measured. */
export function worstSlowdown(rule: string, engines: readonly Engine[] = ENGINES): number | undefined {
  const s = SPEEDUPS[rule];
  if (!s) return undefined;
  let worst = Infinity;
  for (const e of engines) worst = Math.min(worst, s[e].worst);
  return Math.max(0, 1 / worst - 1);
}

export const allowed = (rule: string, maxSlowdown: number, engines: readonly Engine[] = ENGINES) =>
  (worstSlowdown(rule, engines) ?? 0) <= maxSlowdown;
export const offByDefault = (rule: string) => !allowed(rule, parseSlowdown(DEFAULT_MAX_SLOWDOWN)!);

/** `"34%"`, rounded up so that a maxSlowdown of that value lets the rule run. */
export const percent = (x: number) => `${Math.ceil(x * 100 - 1e-9)}%`;

/** Whether a rule with `engines` has one of them among the targets' engines. */
// optilint-disable-next-line lookup-in-loop -- both lists hold at most two engines
export const runsOn = (rule: Rule, engines: readonly Engine[]) => !rule.engines || engines.some((e) => rule.engines!.includes(e));
