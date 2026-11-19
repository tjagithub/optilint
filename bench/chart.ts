// Writes docs/speedups.svg, the README chart of each fix's measured speed-up, from src/speedups.ts.
// Usage: bun bench/chart.ts (`bun run bench:speedups` runs it too).
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_SLOWDOWN, offByDefault } from "../src/slowdown.ts";
import { MEASURED, type Speedup, SPEEDUPS } from "../src/speedups.ts";

export const CHART = path.join(import.meta.dirname, "..", "docs", "speedups.svg");

const W = 760, LEFT = 230, RIGHT = 24, ROW = 22, TOP = 84, AXIS = 46, GAP = 30;
const LO = 0.1, HI = 50;
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
const x = (v: number) => LEFT + ((Math.log(v) - Math.log(LO)) / (Math.log(HI) - Math.log(LO))) * (W - LEFT - RIGHT);
const fmt = (v: number) => `${v >= 10 ? Math.round(v) : Number(v.toFixed(v < 1 ? 2 : 1))}×`;
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const ENGINES = [{ key: "v8", label: "V8 (Node)", dy: -4 }, { key: "jsc", label: "JavaScriptCore (Bun)", dy: 4 }] as const;

/** One engine's worst–best range: a 2px line between two dots, or one dot when they meet. */
function range(s: Speedup, y: number, cls: string) {
  const [a, b] = [x(s.worst), x(s.best)];
  const line = b - a > 0.5 ? `<line class="${cls}" x1="${a.toFixed(1)}" x2="${b.toFixed(1)}" y1="${y}" y2="${y}"/>` : "";
  const dots = [a, ...(b - a > 0.5 ? [b] : [])].map((cx) => `<circle class="${cls} dot" cx="${cx.toFixed(1)}" cy="${y}" r="4"/>`);
  return line + dots.join("");
}

function row(rule: string, y: number, off: boolean) {
  const s = SPEEDUPS[rule]!;
  const tip = `${rule}: V8 ${fmt(s.v8.worst)}–${fmt(s.v8.best)}, JavaScriptCore ${fmt(s.jsc.worst)}–${fmt(s.jsc.best)}`;
  const marks = ENGINES.map((e) => range(s[e.key], y + e.dy, e.key)).join("");
  return `<g><title>${esc(tip)}</title><rect class="hit" x="0" y="${y - ROW / 2}" width="${W}" height="${ROW}"/>` +
    `<text class="${off ? "muted" : "ink"} name" x="${LEFT - 12}" y="${y + 4}" text-anchor="end">${esc(rule)}</text>${marks}</g>`;
}

/** The SVG text; rules sorted by their worst speed-up on either engine, the ones `maxSlowdown` drops last. */
export function chart(): string {
  const worst = (r: string) => Math.min(SPEEDUPS[r]!.v8.worst, SPEEDUPS[r]!.jsc.worst);
  const rules = Object.keys(SPEEDUPS).sort((a, b) => worst(b) - worst(a) || a.localeCompare(b));
  const on = rules.filter((r) => !offByDefault(r));
  const off = rules.filter(offByDefault);
  const offTop = TOP + on.length * ROW + (off.length ? GAP : 0);
  const bottom = offTop + off.length * ROW;
  const H = bottom + AXIS;
  const grid = TICKS.map((t) => `<line class="${t === 1 ? "one" : "grid"}" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${TOP - 16}" y2="${bottom - 6}"/>` +
    `<text class="muted" x="${x(t).toFixed(1)}" y="${bottom + 14}" text-anchor="middle">${fmt(t)}</text>`).join("");
  const legend = ENGINES.map((e, i) => {
    const lx = LEFT + i * 170;
    return `<line class="${e.key}" x1="${lx}" x2="${lx + 22}" y1="44" y2="44"/><circle class="${e.key} dot" cx="${lx}" cy="44" r="4"/>` +
      `<circle class="${e.key} dot" cx="${lx + 22}" cy="44" r="4"/><text class="ink" x="${lx + 32}" y="48">${e.label}</text>`;
  }).join("");
  const offLabel = off.length
    ? `<text class="muted" x="12" y="${offTop - 16}">Off by default: more than ${DEFAULT_MAX_SLOWDOWN} slower somewhere (maxSlowdown)</text>` : "";
  const rows = [...on.map((r, i) => row(r, TOP + i * ROW, false)), ...off.map((r, i) => row(r, offTop + i * ROW, true))];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">optilint fix speed-ups</title>
<desc id="d">Before ÷ after time of each rule's fix, worst to best over compiler tiers and input sizes, on V8 and JavaScriptCore. Data: src/speedups.ts.</desc>
<style>
svg { font: 12px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
.bg { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .muted { fill: #52514e; } .name { font-family: ui-monospace, Menlo, Consolas, monospace; }
.grid { stroke: #e1e0d9; stroke-width: 1; } .one { stroke: #52514e; stroke-width: 1; stroke-dasharray: 3 3; }
.v8, .jsc { stroke-width: 2; stroke-linecap: round; } .v8 { stroke: #2a78d6; } .jsc { stroke: #eb6834; }
.dot { stroke: #fcfcfb; } .v8.dot { fill: #2a78d6; } .jsc.dot { fill: #eb6834; } .hit { fill: transparent; }
g:hover .hit { fill: #e1e0d9; fill-opacity: 0.4; }
@media (prefers-color-scheme: dark) {
  .bg { fill: #1a1a19; } .ink { fill: #f0efec; } .muted { fill: #c3c2b7; } .grid { stroke: #2c2c2a; } .one { stroke: #c3c2b7; }
  .v8 { stroke: #3987e5; } .jsc { stroke: #d95926; } .dot { stroke: #1a1a19; } .v8.dot { fill: #3987e5; } .jsc.dot { fill: #d95926; }
  g:hover .hit { fill: #2c2c2a; }
}
</style>
<rect class="bg" width="${W}" height="${H}" rx="6"/>
<text class="ink" x="12" y="22" font-weight="600">How much faster each fix runs (before ÷ after time, log scale)</text>
<text class="muted" x="12" y="${H - 8}">Worst to best over compiler tiers and input sizes; measured ${MEASURED.date}, Node ${MEASURED.node}, Bun ${MEASURED.bun}. Right of 1× is faster.</text>
${legend}
${grid}
${offLabel}
${rows.join("\n")}
</svg>
`;
}

if (import.meta.main) {
  fs.writeFileSync(CHART, chart());
  console.log(path.relative(process.cwd(), CHART));
}
