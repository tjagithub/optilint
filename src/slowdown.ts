import { worstSpeedup } from "./speedups.ts";

/** Fixes may measure up to this much slower on some tier: bench noise, not a real loss. */
export const DEFAULT_MAX_SLOWDOWN = "10%";

/** `"10%"` → 0.1 and `"any"` → Infinity; undefined for anything else. */
export function parseSlowdown(v: unknown): number | undefined {
  if (v === "any") return Infinity;
  const m = typeof v === "string" ? /^(\d+(?:\.\d+)?)%$/.exec(v) : null;
  return m ? Number(m[1]) / 100 : undefined;
}

/** How much slower a rule's fix measured at worst (0.34: 34% slower); 0 when never slower, undefined when not measured. */
export function worstSlowdown(rule: string): number | undefined {
  const w = worstSpeedup(rule);
  return w === undefined ? undefined : Math.max(0, 1 / w - 1);
}

export const allowed = (rule: string, maxSlowdown: number) => (worstSlowdown(rule) ?? 0) <= maxSlowdown;
export const offByDefault = (rule: string) => !allowed(rule, parseSlowdown(DEFAULT_MAX_SLOWDOWN)!);

/** `"34%"`, rounded up so that a maxSlowdown of that value lets the rule run. */
export const percent = (x: number) => `${Math.ceil(x * 100 - 1e-9)}%`;
