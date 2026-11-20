import path from "node:path";
import type { FileResult } from "./core/engine.ts";
import pkg from "../package.json" with { type: "json" };
import { applies, DEFAULT_SETTINGS, type FileSettings } from "./core/engine.ts";
import type { Finding, Impact, Rule, Tier } from "./core/types.ts";
import { allowed, DEFAULT_MAX_SLOWDOWN, ENGINES, offByDefault, parseSlowdown, percent, TARGETS, worstSlowdown } from "./slowdown.ts";

const ENGINE_NAME = { v8: "V8", jsc: "JavaScriptCore" };

/** ` Targets on V8 alone (node, …) run it.` when one engine's results keep it within the default maxSlowdown. */
function targetsHint(rule: string) {
  const ok = ENGINES.filter((e) => allowed(rule, parseSlowdown(DEFAULT_MAX_SLOWDOWN)!, [e]));
  if (ok.length !== 1) return "";
  const names = Object.entries(TARGETS).filter(([, e]) => e === ok[0]).map(([t]) => t);
  return ` Targets on ${ENGINE_NAME[ok[0]!]} alone (${names.join(", ")}) run it.`;
}
import { MEASURED, SPEEDUPS } from "./speedups.ts";

export const TOOL = { name: "optilint", version: pkg.version };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  red: paint("31"), yellow: paint("33"), dim: paint("2"), bold: paint("1"), cyan: paint("36"), green: paint("32"),
};
const IMPACT_COLOR: Record<Impact, (s: string) => string> = { high: c.red, medium: c.yellow, low: c.dim };

const TIER_COLOR: Record<Tier, (s: string) => string> = { exact: c.green, typed: c.green, assumed: c.cyan };

/** `[cpu 12.3%]`, or `[cold]` when the profile never saw the function run. */
export function cpuTag(f: Finding) {
  if (f.cpu === undefined) return "";
  const pct = f.cpu === 0 ? "cold" : f.cpu < 0.001 ? "cpu <0.1%" : `cpu ${(f.cpu * 100).toFixed(1)}%`;
  return (f.cpu >= 0.01 ? c.bold : c.dim)(` [${pct}]`);
}

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
    // A loop, not Math.max(...): a generated file can have more findings than a call takes arguments.
    let pad = 0, rulePad = 0;
    for (const f of r.findings) {
      pad = Math.max(pad, `${f.line}:${f.col}`.length);
      rulePad = Math.max(rulePad, f.rule.length);
    }
    for (const f of r.findings) {
      counts[f.impact]++;
      if (f.fix && applies(f.fix, settings(r.file))) now++;
      else if (f.fix) more++;
      const loc = `${f.line}:${f.col}`.padEnd(pad);
      const impact = IMPACT_COLOR[f.impact](f.impact.padEnd(6));
      lines.push(`  ${c.dim(loc)}  ${impact}  ${c.cyan(f.rule.padEnd(rulePad))}  ${f.message}${cpuTag(f)}${fixTag(f)}`);
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

export const ruleMeta = ({ kinds: _k, check: _c, ...meta }: Rule) => ({ ...meta, ...(SPEEDUPS[meta.name] && { speedup: SPEEDUPS[meta.name] }) });

/** "Measured 2026-11-16 (...): V8 0.99–3.51x, JSC 1.25–4.22x. At worst 2% slower ..." */
function measured(r: Rule) {
  const s = SPEEDUPS[r.name];
  if (!s) return "";
  const range = (e: { worst: number; best: number }) => `${e.worst.toFixed(2)}–${e.best.toFixed(2)}x`;
  const text = `Measured ${MEASURED.date} (before ÷ after time over every tier): V8 ${range(s.v8)}, JSC ${range(s.jsc)}.`;
  const slow = worstSlowdown(r.name) ?? 0;
  if (!slow) return text;
  const worse = `${text} At worst ${percent(slow)} slower than the original on some tier.`;
  return offByDefault(r.name) ? `${worse} So it is off by default (maxSlowdown ${DEFAULT_MAX_SLOWDOWN}); set maxSlowdown to ${percent(slow)} or more to run it.${targetsHint(r.name)}` : worse;
}
const tiersText = (r: Rule) => (r.tiers.length ? `fix: ${r.tiers.join("/")}${r.obscure ? ", obscure" : ""}` : "");

export function formatRules(rules: readonly Rule[]) {
  const pad = rules.reduce((n, r) => Math.max(n, r.name.length), 0);
  return rules.map((r) => {
    const fix = r.tiers.length ? c.green(` [${tiersText(r)}]`) : "";
    const off = offByDefault(r.name) ? c.dim(` (up to ${percent(worstSlowdown(r.name)!)} slower on some tier: off unless maxSlowdown or targets allow it)`)
      : r.recommended === false ? c.dim(" (not recommended)") : "";
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
  if (r.retired) return `${c.bold(r.name)}  ${c.dim("retired")} · group ${r.group}\n\n${r.description}\n\n${r.why}\n\n${c.dim(`Retired, so it never runs: ${r.retired}`)}`;
  const notes = [r.obscure ? "Its fixes are obscure: --fix applies them only with --obscure." : "", r.recommended === false ? "Not in the recommended preset." : ""];
  return `${c.bold(r.name)}  ${IMPACT_COLOR[r.impact](r.impact)} impact · group ${r.group}\n\n${r.description}\n\n${r.why}\n\n${c.dim([fix, ...notes, measured(r)].filter(Boolean).join(" "))}`;
}
