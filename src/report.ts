import path from "node:path";
import type { FileResult } from "./engine.ts";
import pkg from "../package.json" with { type: "json" };
import { applies, DEFAULT_SETTINGS, type FileSettings } from "./engine.ts";
import type { Finding, Impact, Rule, Tier } from "./types.ts";

export const TOOL = { name: "optilint", version: pkg.version };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  red: paint("31"), yellow: paint("33"), dim: paint("2"), bold: paint("1"), cyan: paint("36"), green: paint("32"),
};
const IMPACT_COLOR: Record<Impact, (s: string) => string> = { high: c.red, medium: c.yellow, low: c.dim };

const TIER_COLOR: Record<Tier, (s: string) => string> = { exact: c.green, typed: c.green, assumed: c.cyan };

function fixTag(f: Finding) {
  if (!f.fix) return "";
  return TIER_COLOR[f.fix.tier](` [fix: ${f.fix.tier}${f.fix.obscure ? ", obscure" : ""}]`);
}

/** `settings` tells which fixes --fix would apply, for the summary line. */
export function formatPretty(results: readonly FileResult[], cwd: string, fixing: boolean, settings: (file: string) => FileSettings = () => DEFAULT_SETTINGS) {
  const lines: string[] = [];
  const counts: Record<Impact, number> = { high: 0, medium: 0, low: 0 };
  let now = 0;
  let more = 0;
  let applied = 0;
  for (const r of results) {
    applied += r.fixesApplied;
    if (!r.findings.length) continue;
    lines.push(c.bold(path.relative(cwd, r.file) || r.file));
    const pad = Math.max(...r.findings.map((f) => `${f.line}:${f.col}`.length));
    const rulePad = Math.max(...r.findings.map((f) => f.rule.length));
    for (const f of r.findings) {
      counts[f.impact]++;
      if (f.fix && applies(f.fix, settings(r.file))) now++;
      else if (f.fix) more++;
      const loc = `${f.line}:${f.col}`.padEnd(pad);
      const impact = IMPACT_COLOR[f.impact](f.impact.padEnd(6));
      lines.push(`  ${c.dim(loc)}  ${impact}  ${c.cyan(f.rule.padEnd(rulePad))}  ${f.message}${fixTag(f)}`);
    }
    lines.push("");
  }
  const total = counts.high + counts.medium + counts.low;
  if (applied) lines.push(c.green(`✔ applied ${applied} fix${applied === 1 ? "" : "es"}`));
  if (!total) {
    lines.push(c.green(fixing ? "✔ nothing left to optimize" : "✔ no findings"));
    return lines.join("\n");
  }
  const parts = (["high", "medium", "low"] as const).filter((k) => counts[k]).map((k) => IMPACT_COLOR[k](`${counts[k]} ${k}`));
  let summary = `✖ ${total} finding${total === 1 ? "" : "s"} (${parts.join(", ")})`;
  const hints = [];
  if (now) hints.push(`${now} fixable with --fix`);
  if (more) hints.push(`${more} more with --tier assumed / --obscure`);
  if (hints.length) summary += c.dim(` · ${hints.join(", ")}`);
  lines.push(summary);
  return lines.join("\n");
}

/** See outputSchema(); `fix.edits` are UTF-16 offsets into the linted text, so they map onto editor offsets. */
export function formatJson(results: readonly FileResult[], describe?: (rule: string) => string | undefined) {
  const findings = results.flatMap((r) => r.findings.map((f) => ({ ...f, description: describe?.(f.rule), fix: f.fix ?? null })));
  return JSON.stringify({ version: 1, tool: TOOL, findings }, null, 2);
}

export const ruleMeta = ({ kinds: _k, check: _c, ...meta }: Rule) => meta;
const tiersText = (r: Rule) => (r.tiers.length ? `fix: ${r.tiers.join("/")}${r.obscure ? ", obscure" : ""}` : "");

export function formatRules(rules: readonly Rule[]) {
  const pad = Math.max(...rules.map((r) => r.name.length));
  return rules.map((r) => {
    const fix = r.tiers.length ? c.green(` [${tiersText(r)}]`) : "";
    const off = r.recommended === false ? c.dim(" (not recommended)") : "";
    return `${c.cyan(r.name.padEnd(pad))}  ${IMPACT_COLOR[r.impact](r.impact.padEnd(6))}  ${r.description}${fix}${off}`;
  }).join("\n");
}

const TIER_TEXT: [Tier, string][] = [
  ["exact", "exact (same behaviour for every input)"],
  ["typed", "typed (proven from the types)"],
  ["assumed", "assumed (when the types cannot prove it; needs --tier assumed)"],
];

export function formatExplain(r: Rule) {
  const fix = r.tiers.length ? `Fixes: ${TIER_TEXT.filter(([t]) => r.tiers.includes(t)).map(([, s]) => s).join("; ")}.` : "No fix; report only.";
  const notes = [r.obscure ? "Its fixes are obscure: --fix applies them only with --obscure." : "", r.recommended === false ? "Not in the recommended preset." : ""];
  return `${c.bold(r.name)}  ${IMPACT_COLOR[r.impact](r.impact)} impact · group ${r.group}\n\n${r.description}\n\n${r.why}\n\n${c.dim([fix, ...notes].filter(Boolean).join(" "))}`;
}
