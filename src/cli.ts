#!/usr/bin/env bun
import fs from "node:fs";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { serve } from "./mcp.ts";
import { startUi } from "./ui.ts";
import { defaultCacheLocation } from "./cache.ts";
import { formatExplain, formatJson, formatPretty, formatRules, ruleMeta, TOOL } from "./report.ts";
import { allRules, retiredByName, ruleByName } from "./rules/index.ts";
import { defaultWorkers, layer, runParallel, unifiedDiff, UsageError } from "./runner.ts";
import { formatSarif } from "./sarif.ts";
import { configSchema, outputSchema } from "./schema.ts";

const HELP = `optilint: find and fix JS/TS performance problems

Usage: optilint [paths...] [options]

Fixing:
  --fix              apply fixes up to the configured tier (default: typed)
  --tier TIER        exact | typed | assumed: the highest tier to apply
  --obscure          also apply obscure fixes (correct but hard to read)
  --fix-unsafe       same as --fix --tier assumed
  --diff             print fixes as a unified diff instead of writing files

Selecting:
  --rule a,b         run only these rules or groups
  --disable a,b      turn rules or groups off
  --min-impact LVL   only report high | medium | low (default: low)
  --max-slowdown PCT skip rules whose fix measured more than PCT slower on some
                     engine or tier (default: 10%; 0%: never slower; any: no limit)
  --ignore GLOB      skip matching paths (repeatable)
  --config PATH      config file (default: nearest optilint.json(c) or package.json "optilint")
  --project PATH     tsconfig.json to read compiler options from
  --workers N        lint projects on N threads (default: up to 4; 0 or 1: none)
  --cache            reuse findings for files whose content and imports are unchanged
                     (not with --fix or --diff)
  --cache-location P the cache file (default: node_modules/.cache/optilint/cache.json)
  --profile FILE     rank findings by CPU time in a .cpuprofile (node --cpu-prof);
                     code it never saw run drops to low impact (repeatable)

Output:
  --format FMT       pretty | json | sarif (default: pretty)
  --stdin-filename F lint stdin as file F; with --fix, print the fixed text
  --list-rules       list all rules (with --format json: their metadata)
  --explain RULE     explain a rule
  --print-schema K   print the JSON Schema of the config or the json output
  --mcp              run as an MCP server on stdio (tools: lint, fix, rules)
  --ui               open a page in the browser to review findings by tier and
                     apply the fixes you pick (served on 127.0.0.1)
  --version          print the version
  -h, --help         show this help

Tiers: exact = same behaviour for every input; typed = for every input the types
allow; assumed = only if the stated assumption holds.

Inline: // optilint-disable-next-line rule-a, rule-b
        // optilint-disable-line
        // optilint-disable-file rule-a`;

function fail(message: string): never {
  console.error(`optilint: ${message}`);
  process.exit(2);
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UsageError) fail(e.message);
    throw e;
  }
}

const describe = (rule: string) => ruleByName.get(rule)?.description;
// Repeated flags add up: `--rule a --rule b` is `--rule a,b`.
const list = (values?: string[]) => (values ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));

// parseArgs throws TypeError (code ERR_PARSE_ARGS_*) with a long hint; keep its first sentence.
function parse() {
  try {
    return parseOptions();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (!code?.startsWith("ERR_PARSE_ARGS_")) throw e;
    throw new UsageError(`${(e as Error).message.split(". ")[0]!.replace(/\.$/, "")}; see --help`);
  }
}

function parseOptions() {
  return parseArgs({
    allowPositionals: true,
    options: {
      fix: { type: "boolean" }, "fix-unsafe": { type: "boolean" }, diff: { type: "boolean" },
      tier: { type: "string" }, obscure: { type: "boolean" },
      rule: { type: "string", multiple: true }, disable: { type: "string", multiple: true }, "min-impact": { type: "string" }, "max-slowdown": { type: "string" },
      format: { type: "string" }, project: { type: "string" }, config: { type: "string" },
      "list-rules": { type: "boolean" }, explain: { type: "string" }, "print-schema": { type: "string" },
      help: { type: "boolean", short: "h" }, mcp: { type: "boolean" }, ui: { type: "boolean" }, version: { type: "boolean" },
      "stdin-filename": { type: "string" }, workers: { type: "string" }, cache: { type: "boolean" }, "cache-location": { type: "string" }, ignore: { type: "string", multiple: true },
      profile: { type: "string", multiple: true },
    },
  });
}

const cliLayer = (values: ReturnType<typeof parseOptions>["values"]) => layer({
  only: list(values.rule), disable: list(values.disable), ignore: values.ignore,
  tier: values["fix-unsafe"] ? "assumed" : values.tier, obscure: values.obscure, minImpact: values["min-impact"], maxSlowdown: values["max-slowdown"],
});

async function main() {
  const { values, positionals } = guard(parse);
  const format = values.format ?? "pretty";
  if (!["pretty", "json", "sarif"].includes(format)) fail(`invalid --format: ${format}`);
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(`${TOOL.name} ${TOOL.version}`);
  if (values.mcp) return serve(process.cwd());
  if (values["print-schema"]) {
    const kind = values["print-schema"];
    if (kind !== "config" && kind !== "output") fail(`invalid --print-schema: ${kind} (config | output)`);
    return json(kind === "config" ? configSchema() : outputSchema());
  }
  if (values["list-rules"]) {
    if (format === "pretty") return console.log(formatRules(allRules));
    return json({ version: 1, tool: TOOL, rules: allRules.map(ruleMeta) });
  }
  if (values.explain) {
    const r = ruleByName.get(values.explain) ?? retiredByName.get(values.explain);
    if (!r) fail(`unknown rule: ${values.explain}`);
    return console.log(formatExplain(r));
  }

  const cwd = process.cwd();
  const stdinName = values["stdin-filename"];
  const text = stdinName ? fs.readFileSync(0, "utf8") : undefined;
  const fix = !!(values.fix || values["fix-unsafe"] || values.diff);
  const workers = values.workers === undefined ? defaultWorkers() : Number(values.workers);
  if (!Number.isInteger(workers) || workers < 0) fail(`invalid --workers: ${values.workers}`);
  if (values.ui) {
    if (fix || stdinName || values.cache) fail("--ui takes no --fix, --diff, --stdin-filename or --cache");
    const ui = await startUi({ request: guard(() => ({ cwd, paths: positionals, config: values.config, project: values.project, profiles: values.profile, layer: cliLayer(values) })), workers, open: true });
    return console.log(`optilint UI: ${ui.url}\nPress Ctrl-C to stop.`);
  }
  const { results, rules, config, errors, excluded } = await runParallel(guard(() => ({
    cwd, paths: positionals, buffer: stdinName ? { file: stdinName, text: text! } : undefined, fix,
    config: values.config, project: values.project, profiles: values.profile,
    cache: values.cache || values["cache-location"] ? (values["cache-location"] ?? defaultCacheLocation(cwd)) : undefined,
    layer: cliLayer(values),
  })), workers).catch((e: unknown) => {
    if (e instanceof UsageError) fail(e.message);
    throw e;
  });
  for (const e of errors) console.error(`optilint: internal error: ${e}`);

  // An editor sends every file; one the config leaves out gets no findings.
  if (excluded) {
    if (fix) process.stdout.write(text!);
    else if (format === "json") console.log(formatJson([]));
    else if (format === "sarif") console.log(formatSarif([], rules, cwd));
    process.exit(0);
  }
  if (stdinName && fix) {
    process.stdout.write(results[0]!.output);
    process.exit(0);
  }
  if (!stdinName) {
    for (const r of results) {
      if (r.output === r.original) continue;
      if (values.diff) process.stdout.write(unifiedDiff(r.file, r.original, r.output, cwd));
      else fs.writeFileSync(r.file, r.output);
    }
  }
  const remaining = values.diff ? results.map((r) => ({ ...r, findings: [] })) : results;
  if (format === "json") console.log(formatJson(remaining, describe));
  else if (format === "sarif") console.log(formatSarif(remaining, rules, cwd));
  else if (!values.diff) console.log(formatPretty(remaining, cwd, fix, (f) => config.settingsFor(f)));
  // Findings set to "info" are advice; they do not fail a run.
  process.exit(remaining.some((r) => r.findings.some((f) => f.severity !== "info")) ? 1 : 0);
}

// A lint worker of the Node bundle loads this file too; only the main thread runs the CLI.
if (isMainThread) void main();
