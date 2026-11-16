/** Engine and compiler tier to run a bench on. Checked 2026-11-16 with %GetOptimizationStatus (V8)
 * and bun:jsc numberOfDFGCompiles plus timings (JSC): each flag set stops at the tier named. */
export interface EngineTier {
  id: string;
  /** The engine's default top tier; `--tiers peak` runs only these. */
  peak?: boolean;
  cmd: "node" | "bun";
  args?: string[];
  env?: Record<string, string>;
}

export const TIERS: readonly EngineTier[] = [
  { id: "node:turbofan", peak: true, cmd: "node" },
  { id: "node:maglev", cmd: "node", args: ["--no-turbofan"] },
  { id: "node:sparkplug", cmd: "node", args: ["--no-turbofan", "--no-maglev"] },
  { id: "node:ignition", cmd: "node", args: ["--no-turbofan", "--no-maglev", "--no-sparkplug"] },
  { id: "bun:ftl", peak: true, cmd: "bun" },
  { id: "bun:dfg", cmd: "bun", env: { BUN_JSC_useFTLJIT: "0" } },
  { id: "bun:baseline", cmd: "bun", env: { BUN_JSC_useDFGJIT: "0" } },
  { id: "bun:llint", cmd: "bun", env: { BUN_JSC_useJIT: "0" } },
];

/** `peak`, `all`, or a comma list of ids or engine names (`node`, `bun:dfg`). */
export function selectTiers(spec: string): EngineTier[] {
  if (spec === "all") return [...TIERS];
  if (spec === "peak") return TIERS.filter((t) => t.peak);
  const wanted = spec.split(",").map((s) => s.trim());
  const picked = TIERS.filter((t) => wanted.some((w) => t.id === w || t.cmd === w));
  const unknown = wanted.filter((w) => !TIERS.some((t) => t.id === w || t.cmd === w));
  if (unknown.length) throw new Error(`unknown tier: ${unknown.join(", ")} (known: ${TIERS.map((t) => t.id).join(", ")})`);
  return picked;
}
