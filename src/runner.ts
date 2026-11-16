import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CliLayer, type Config, ConfigError, findConfig, loadConfig } from "./config.ts";
import { type FileResult, lint, loadProject } from "./core/engine.ts";
import { TIERS } from "./core/fix.ts";
import { allRules } from "./rules/index.ts";
import type { Impact, Rule, Tier } from "./core/types.ts";
import { IMPACTS, validateNames } from "./validate.ts";

/** A bad request: the CLI exits with 2, the MCP server returns a tool error. */
export class UsageError extends Error {}

const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "out", ".next", ".turbo", "vendor"]);
const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 };

export function collect(target: string, cwd: string, out: string[]) {
  const abs = path.resolve(cwd, target);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new UsageError(`no such file or directory: ${target}`);
  if (stat.isFile()) return void out.push(abs);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) collect(full, cwd, out);
    } else if (EXTENSIONS.test(entry.name) && !/\.d\.[cm]?ts$|\.min\.js$/.test(entry.name)) {
      out.push(full);
    }
  }
}

export interface LayerInput {
  only?: string[];
  disable?: string[];
  ignore?: string[];
  tier?: string;
  obscure?: boolean;
  minImpact?: string;
}

/** Checks the command-line (or tool-call) settings that sit on top of the config. */
export function layer(input: LayerInput): CliLayer {
  const only = input.only ?? [];
  const disable = input.disable ?? [];
  const bad = validateNames([...only, ...disable]);
  if (bad.length) throw new UsageError(bad.join("\n"));
  if (input.tier !== undefined && !TIERS.includes(input.tier as Tier)) {
    throw new UsageError(`invalid --tier: ${input.tier} (exact | typed | assumed)`);
  }
  if (input.minImpact !== undefined && !IMPACTS.includes(input.minImpact)) throw new UsageError(`invalid --min-impact: ${input.minImpact}`);
  return {
    only, disable, ignore: input.ignore, tier: input.tier as Tier | undefined,
    obscure: input.obscure, minImpact: input.minImpact as Impact | undefined,
  };
}

export interface Request {
  cwd: string;
  paths?: readonly string[];
  /** One buffer linted as `file`; imports resolve against the files on disk. */
  buffer?: { file: string; text: string };
  fix: boolean;
  layer: CliLayer;
  config?: string;
  project?: string;
}

export interface Run {
  results: FileResult[];
  rules: readonly Rule[];
  config: Config;
  errors: string[];
  /** The config leaves the buffer's file out, so nothing ran. */
  excluded: boolean;
}

export function run(req: Request): Run {
  const { cwd } = req;
  const bufferFile = req.buffer && path.resolve(cwd, req.buffer.file);
  let config: Config;
  try {
    config = loadConfig(req.config ?? findConfig(bufferFile ? path.dirname(bufferFile) : cwd), req.layer, cwd);
  } catch (e) {
    if (e instanceof ConfigError) throw new UsageError(e.message);
    throw e;
  }
  const rules = allRules.filter((r) => IMPACT_RANK[r.impact] >= IMPACT_RANK[config.minImpact]);

  const files: string[] = [];
  const sources = new Map<string, string>();
  if (bufferFile) {
    if (!config.selects(bufferFile)) return { results: [], rules, config, errors: [], excluded: true };
    files.push(bufferFile);
    sources.set(bufferFile, req.buffer!.text);
  } else {
    for (const p of req.paths?.length ? req.paths : ["."]) collect(p, cwd, files);
    files.splice(0, files.length, ...files.filter((f) => config.selects(f)).sort());
    if (!files.length) throw new UsageError("no JavaScript or TypeScript files found");
  }

  // A buffer belongs to the tsconfig nearest to it, which in a monorepo is not the root one.
  const project = loadProject(bufferFile ? path.dirname(bufferFile) : cwd, req.project && path.resolve(cwd, req.project));
  const errors = new Set<string>();
  const results = lint(files, {
    rules, fix: req.fix, settings: (f) => config.settingsFor(f), compilerOptions: project.options, extraRoots: project.ambient,
    onRuleError: (rule, file, e) => errors.add(`${rule} crashed on ${path.relative(cwd, file)}: ${(e as Error).message}`),
  }, sources);
  return { results, rules, config, errors: [...errors], excluded: false };
}

export function unifiedDiff(file: string, before: string, after: string, cwd: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-"));
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  fs.writeFileSync(a, before);
  fs.writeFileSync(b, after);
  const rel = path.relative(cwd, file);
  const res = spawnSync("diff", ["-u", "--label", `a/${rel}`, "--label", `b/${rel}`, a, b], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return res.stdout;
}
