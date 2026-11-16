import type { Edit, Fix, Tier, Tri } from "./types.ts";

export const TIERS: readonly Tier[] = ["exact", "typed", "assumed"];
export const tierRank = (t: Tier) => TIERS.indexOf(t);
export const maxTier = (a: Tier, b: Tier) => (tierRank(a) >= tierRank(b) ? a : b);

/** Tier from type knowledge: proven → typed, unknown → assumed, disproven → no finding. */
export function byType(tri: Tri): Tier | undefined {
  return tri === "yes" ? "typed" : tri === "maybe" ? "assumed" : undefined;
}

/** A fix; `assumes` is kept only for the assumed tier, where it is what the fix takes on trust. */
export function fix(tier: Tier, edits: Edit[], assumes?: string, obscure = false): Fix {
  return {
    tier, edits,
    ...(tier === "assumed" && assumes ? { assumes } : {}),
    ...(obscure ? { obscure } : {}),
  };
}
