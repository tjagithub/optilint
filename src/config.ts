import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { FileSettings, RuleSetting } from "./core/engine.ts";
import { globMatch } from "./core/glob.ts";
import { allRules, groups } from "./rules/index.ts";
import type { Impact, Severity, Tier } from "./core/types.ts";
import { DEFAULT_MAX_SLOWDOWN, parseSlowdown } from "./slowdown.ts";
import { validate } from "./validate.ts";

export type Level = "off" | "on" | Severity;
export type Preset = "recommended" | "all" | "none";
export type RuleValue = Level | { level: Level; tier?: Tier | "none" };
/** `preset`, then group names (a level, or an object of their rules), then rule names. */
export type RulesConfig = { [key: string]: Preset | RuleValue | Record<string, RuleValue> | undefined };

export interface Override {
  include: string[];
  tier?: Tier;
  obscure?: boolean;
  rules?: RulesConfig;
}

export interface RawConfig {
  $schema?: string;
  extends?: string[];
  files?: { include?: string[]; ignore?: string[] };
  /** Same as files.ignore (the original format). */
  ignore?: string[];
  tier?: Tier;
  obscure?: boolean;
  minImpact?: Impact;
  maxSlowdown?: string;
  rules?: RulesConfig;
  overrides?: Override[];
}

export class ConfigError extends Error {}

/** One config file's contents and the directory its globs are relative to. */
interface Layer {
  base: string;
  raw: RawConfig;
}

export interface Config {
  /** The file it came from, if any. */
  file?: string;
  minImpact: Impact;
  /** Rules whose fix measured more than this much slower anywhere do not run (0.1 = 10%; `src/slowdown.ts`). */
  maxSlowdown: number;
  /** Whether files.include / files.ignore select `file` (an absolute path). */
  selects(file: string): boolean;
  settingsFor(file: string): FileSettings;
}

export const CONFIG_NAMES = ["optilint.json", "optilint.jsonc"];
/** Folders the file walk never enters, whatever files.include says (nor any starting with a dot). */
export const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "coverage", "out", ".next", ".turbo", "vendor"];
const ROOT_NOT_OBJECT = 5092;

/** Reads JSON with comments and trailing commas, as tsconfig.json allows; package.json stays strict JSON. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
    if (path.basename(file) === "package.json") return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`);
  }
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error?.code === ROOT_NOT_OBJECT || !text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "").trim()) throw new ConfigError(`${file}: config must be a JSON object`);
  if (error) {
    const { line, character } = ts.getLineAndCharacterOfPosition(ts.createSourceFile(file, text, ts.ScriptTarget.Latest), error.start ?? 0);
    throw new ConfigError(`${file}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  }
  return config;
}

/** Nearest optilint.json(c), or package.json with an "optilint" key, from `dir` upward. */
export function findConfig(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const found = CONFIG_NAMES.filter((name) => fs.existsSync(path.join(d, name)));
    if (found.length > 1) throw new ConfigError(`${d}: both ${found.join(" and ")} exist; keep one`);
    if (found[0]) return path.join(d, found[0]);
    const pkg = path.join(d, "package.json");
    if (fs.existsSync(pkg)) {
      // A broken package.json is not ours to report.
      const json = (() => { try { return JSON.parse(fs.readFileSync(pkg, "utf8")); } catch { return undefined; } })();
      if (json?.optilint !== undefined) return pkg;
    }
    if (path.dirname(d) === d) return undefined;
  }
}

function readLayers(file: string, chain: string[] = []): Layer[] {
  if (chain.includes(file)) throw new ConfigError(`circular "extends": ${[...chain, file].join(" → ")}`);
  const json = readJson(file);
  const raw = path.basename(file) === "package.json" ? (json as { optilint?: unknown }).optilint : json;
  const errors = validate(raw);
  if (errors.length) throw new ConfigError(errors.map((e) => `${file}: ${e}`).join("\n"));
  const base = path.dirname(file);
  const config = raw as RawConfig;
  const parents = (config.extends ?? []).flatMap((p) => {
    const target = path.resolve(base, p);
    if (!fs.existsSync(target)) throw new ConfigError(`${file}: "extends" target not found: ${p}`);
    return readLayers(target, [...chain, file]);
  });
  return [...parents, { base, raw: config }];
}

function matches(patterns: readonly string[], base: string, file: string) {
  const rel = path.relative(base, file).split(path.sep).join("/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) return false;
  // A pattern naming a directory also covers what is inside it.
  return patterns.some((p) => globMatch(p, rel) || rel.split("/").some((_, i, parts) => globMatch(p, parts.slice(0, i + 1).join("/"))));
}

function set(state: Map<string, RuleSetting>, name: string, value: RuleValue) {
  const { level, tier } = typeof value === "string" ? { level: value, tier: undefined } : value;
  if (level === "off") return void state.delete(name);
  const prev = state.get(name) ?? {};
  state.set(name, { ...prev, ...(level !== "on" ? { severity: level } : {}), ...(tier ? { floor: tier } : {}) });
}

function preset(state: Map<string, RuleSetting>, p: Preset) {
  state.clear();
  for (const r of allRules) if (p === "all" || (p === "recommended" && r.recommended !== false)) state.set(r.name, {});
}

/** Apply one `rules` object: preset first, then groups, then single rules, so the most specific wins. */
export function applyRules(state: Map<string, RuleSetting>, rules?: RulesConfig) {
  if (!rules) return;
  if (rules.preset) preset(state, rules.preset as Preset);
  for (const [key, value] of Object.entries(rules)) {
    if (!groups.includes(key) || value === undefined) continue;
    if (typeof value === "string") {
      for (const r of allRules) if (r.group === key) set(state, r.name, value as Level);
    } else {
      for (const [name, v] of Object.entries(value as Record<string, RuleValue>)) set(state, name, v);
    }
  }
  for (const [key, value] of Object.entries(rules)) {
    if (key !== "preset" && !groups.includes(key) && value !== undefined) set(state, key, value as RuleValue);
  }
}

/** Settings given on the command line, applied after every config layer. */
export interface CliLayer {
  tier?: Tier;
  obscure?: boolean;
  minImpact?: Impact;
  maxSlowdown?: number;
  only?: string[];
  disable?: string[];
  ignore?: string[];
}

export function loadConfig(file: string | undefined, cli: CliLayer = {}, cwd = process.cwd()): Config {
  const layers = file ? readLayers(path.resolve(cwd, file)) : [];
  const last = <K extends keyof RawConfig>(key: K) => layers.findLast((l) => l.raw[key] !== undefined)?.raw[key];
  const include = layers.findLast((l) => l.raw.files?.include);
  const ignores = [
    ...layers.map((l) => ({ base: l.base, globs: [...(l.raw.ignore ?? []), ...(l.raw.files?.ignore ?? [])] })),
    { base: cwd, globs: cli.ignore ?? [] },
  ];
  const overrides = layers.flatMap((l) => (l.raw.overrides ?? []).map((o) => ({ base: l.base, o })));
  const cache = new Map<string, FileSettings>();

  return {
    file: file && path.resolve(cwd, file),
    minImpact: cli.minImpact ?? last("minImpact") ?? "low",
    maxSlowdown: cli.maxSlowdown ?? parseSlowdown(last("maxSlowdown") ?? DEFAULT_MAX_SLOWDOWN)!,
    selects(f) {
      if (include && !matches(include.raw.files!.include!, include.base, f)) return false;
      return !ignores.some((i) => i.globs.length && matches(i.globs, i.base, f));
    },
    settingsFor(f) {
      const hit = cache.get(f);
      if (hit) return hit;
      const state = new Map<string, RuleSetting>();
      preset(state, "recommended");
      let tier: Tier = last("tier") ?? "typed";
      let obscure = last("obscure") ?? false;
      for (const l of layers) applyRules(state, l.raw.rules);
      for (const { base, o } of overrides) {
        if (!matches(o.include, base, f)) continue;
        applyRules(state, o.rules);
        tier = o.tier ?? tier;
        obscure = o.obscure ?? obscure;
      }
      if (cli.only?.length) applyRules(state, { preset: "none", ...Object.fromEntries(cli.only.map((r) => [r, "on"])) });
      if (cli.disable?.length) applyRules(state, Object.fromEntries(cli.disable.map((r) => [r, "off"])));
      const out = { rules: state, tier: cli.tier ?? tier, obscure: cli.obscure ?? obscure };
      cache.set(f, out);
      return out;
    },
  };
}
