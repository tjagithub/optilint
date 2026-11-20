// Writes the generated parts of the website (docs/): the home page's numbers and demo, and the rule reference.
// `bun run site:build` runs it before `vitepress build`; its output is gitignored.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allRules, groups, retiredRules } from "../src/rules/index.ts";
import { MEASURED, SPEEDUPS } from "../src/speedups.ts";
import { configSchema } from "../src/schema.ts";
import type { Rule } from "../src/core/types.ts";

const root = path.join(import.meta.dir, "..");
const docs = path.join(root, "docs");
const gen = path.join(docs, ".vitepress", "gen");

const DEMO = `interface User { id: string; name: string; admin: boolean }

export async function summary(users: User[], ids: string[]) {
  const byId = users.reduce((acc, u) => ({ ...acc, [u.id]: u }), {});
  const picked = ids.filter((id) => users.find((u) => u.id === id));
  const firstAdmin = users.filter((u) => u.admin)[0];
  const staff = users.filter((u) => /^staff-/.test(u.name));
  const profile = await fetchProfile();
  const settings = await fetchSettings();
  return { byId, picked, firstAdmin, staff, profile, settings, at: new Date().getTime() };
}

declare function fetchProfile(): Promise<object>;
declare function fetchSettings(): Promise<object>;
`;

function optilint(cwd: string, ...args: string[]) {
  const out = Bun.spawnSync(["bun", path.join(root, "src/cli.ts"), ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
  return out.stdout.toString().trimEnd();
}

function demo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-site-"));
  try {
    fs.writeFileSync(path.join(dir, "summary.ts"), DEMO);
    const output = optilint(dir, "summary.ts");
    const diff = optilint(dir, "summary.ts", "--diff", "--tier", "assumed");
    if (!output.includes("findings") || !diff.startsWith("---")) throw new Error(`demo run failed:\n${output}\n${diff}`);
    return { source: DEMO, output, diff };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const times = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(2).replace(/\.?0+$/, "")}×`;

function speed(name: string) {
  const s = SPEEDUPS[name];
  if (!s) return "";
  return `Measured speedup: V8 ${times(s.v8.worst)}–${times(s.v8.best)}, JavaScriptCore ${times(s.jsc.worst)}–${times(s.jsc.best)}.`;
}

function ruleSection(r: Rule) {
  const fixes = r.tiers.length ? `Fixes: ${r.tiers.map((t) => `\`${t}\``).join(", ")}${r.obscure ? " (obscure)" : ""}.` : "Report only.";
  const preset = (r.recommended === false ? " Not in the recommended preset." : "") + (r.engines ? ` Runs only when a target is on ${r.engines.map((e) => (e === "v8" ? "V8" : "JavaScriptCore")).join(" or ")}.` : "");
  const retired = r.retired ? `\n\n::: warning Retired\n${r.retired}\n:::` : "";
  return [`### ${r.name}`, r.description, r.why, `**${r.impact}** impact. ${fixes}${preset} ${speed(r.name)}`.trimEnd() + retired].join("\n\n");
}

function reference() {
  const parts = [
    "---\ntitle: Rule reference\noutline: [2, 3]\n---",
    "# Rule reference",
    `Generated from the rule definitions. Speedups are before ÷ after time of the fix, worst and best over every compiler tier and input size, measured ${MEASURED.date} on Node ${MEASURED.node} and Bun ${MEASURED.bun}. \`optilint --explain <rule>\` prints the same text.`,
  ];
  for (const g of groups) parts.push(`## ${g}`, ...allRules.filter((r) => r.group === g).map(ruleSection));
  if (retiredRules.length) parts.push("## Retired", "These rules never run: their fix measured slower. They are kept so a run on newer engines can bring them back.", ...retiredRules.map(ruleSection));
  return parts.join("\n\n") + "\n";
}

const best = Math.max(...Object.entries(SPEEDUPS).filter(([n]) => allRules.some((r) => r.name === n)).map(([, s]) => Math.max(s.v8.best, s.jsc.best)));
const home = {
  version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version as string,
  stats: {
    rules: allRules.length,
    fixable: allRules.filter((r) => r.tiers.length).length,
    measured: allRules.filter((r) => SPEEDUPS[r.name]).length,
    best: times(best),
  },
  demo: demo(),
};

fs.mkdirSync(gen, { recursive: true });
fs.writeFileSync(path.join(gen, "home.json"), JSON.stringify(home, null, 2) + "\n");
fs.writeFileSync(path.join(docs, "reference.md"), reference());
// optilint --init points $schema here (SCHEMA_URL in src/init.ts).
fs.writeFileSync(path.join(docs, "public", "schema.json"), JSON.stringify(configSchema(), null, 2) + "\n");
console.log(`site: ${home.stats.rules} rules, demo and reference written`);
