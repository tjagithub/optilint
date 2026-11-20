import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LintCache, planCached, recordCached } from "./cache.ts";
import { type CliLayer, type Config, ConfigError, findConfig, loadConfig, SKIP_DIRS } from "./config.ts";
import type { FileResult, FileSettings } from "./core/engine.ts";
import { TIERS } from "./core/fix.ts";
import { type Project, ProjectResolver } from "./core/project.ts";
import { type Job, type JobResult, lintJob } from "./job.ts";
import { LintPool } from "./pool.ts";
import { byHeat, Profile } from "./profile.ts";
import { allRules } from "./rules/index.ts";
import type { Impact, Rule, Tier } from "./core/types.ts";
import { allowed, parseSlowdown } from "./slowdown.ts";
import { IMPACTS, validateNames } from "./validate.ts";

/** A bad request: the CLI exits with 2, the MCP server returns a tool error. */
export class UsageError extends Error {}

const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(SKIP_DIRS);
const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 };

const isSource = (name: string) => EXTENSIONS.test(name) && !/\.d\.[cm]?ts$|\.min\.js$/.test(name);
const skipDir = (name: string) => SKIP.has(name) || name.startsWith(".");

/** Files and directories named on the command line; a directory gives its source files, as git lists them when it can. */
export function collect(target: string, cwd: string, out: string[]) {
  const abs = within(cwd, path.resolve(cwd, target));
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new UsageError(`no such file or directory: ${target}`);
  if (stat.isFile()) return void out.push(abs);
  const listed = gitFiles(abs)?.filter((rel) => isSource(rel) && !rel.split("/").slice(0, -1).some(skipDir));
  // An ignored directory named outright (git lists nothing in it) is walked instead.
  if (!listed?.length) return walk(abs, out);
  for (const rel of listed) {
    const full = path.join(abs, rel);
    if (fs.statSync(full, { throwIfNoEntry: false })?.isFile()) out.push(full);
  }
}

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(entry.name)) walk(full, out);
    } else if (isSource(entry.name)) {
      out.push(full);
    }
  }
}

/** The files git has under `dir`: tracked ones, and untracked ones that .gitignore lets through. Like git, it leaves out
 * submodules and what symlinked directories hold. Undefined outside a work tree or without git. */
function gitFiles(dir: string): string[] | undefined {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) return undefined;
  return [...new Set(r.stdout.split("\0").filter(Boolean))];
}

/** A path outside `cwd` that is inside it once symlinks resolve (/tmp is /private/tmp on macOS), rebased onto `cwd`. */
function within(cwd: string, abs: string): string {
  const outside = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside(path.relative(cwd, abs))) return abs;
  try {
    const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(abs));
    return outside(rel) ? abs : path.join(cwd, rel);
  } catch {
    return abs;
  }
}

export interface LayerInput {
  only?: string[];
  disable?: string[];
  ignore?: string[];
  tier?: string;
  obscure?: boolean;
  minImpact?: string;
  /** "10%" or "any". */
  maxSlowdown?: string;
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
  const maxSlowdown = input.maxSlowdown === undefined ? undefined : parseSlowdown(input.maxSlowdown);
  if (input.maxSlowdown !== undefined && maxSlowdown === undefined) {
    throw new UsageError(`invalid --max-slowdown: ${input.maxSlowdown} (a percentage such as 10%, or any)`);
  }
  return {
    only, disable, ignore: input.ignore, tier: input.tier as Tier | undefined,
    obscure: input.obscure, minImpact: input.minImpact as Impact | undefined, maxSlowdown,
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
  /** Cache file for findings; used only without fixes and without a buffer. */
  cache?: string;
  /** `.cpuprofile` files: rank findings by the CPU time of their function; ones that never ran drop to low. */
  profiles?: readonly string[];
}

export interface Run {
  results: FileResult[];
  rules: readonly Rule[];
  config: Config;
  errors: string[];
  /** The config leaves the buffer's file out, so nothing ran. */
  excluded: boolean;
  /** Files whose findings came from the cache. */
  cached: number;
}

/** The jobs a request needs, and how to turn their results into the run. */
interface Prepared {
  jobs: Job[];
  finish(done: JobResult[]): Run;
}

export function run(req: Request): Run {
  const p = prepare(req);
  return p.finish(p.jobs.map(lintJob));
}

/** Measured on babel (150 projects): 4 workers beat 6 and 10 on Bun and on Node; each worker warms its own JIT. */
export const defaultWorkers = () => Math.min(4, Math.max(1, os.availableParallelism() - 1));

// Each worker loads TypeScript and re-parses the files its programs share, so a run with few files stays inline.
const MIN_PARALLEL_FILES = 100;

/** `run`, with the projects spread over `workers` threads when there are enough files and no project dominates.
 * One program cannot be split: each part would rebuild it, which measured slower than linting it inline. */
export async function runParallel(req: Request, workers: number): Promise<Run> {
  const p = prepare(req);
  const sizes = p.jobs.map((j) => j.files.length);
  const files = sizes.reduce((a, b) => a + b, 0);
  if (workers < 2 || files < MIN_PARALLEL_FILES || Math.max(0, ...sizes) > files / 2) return p.finish(p.jobs.map(lintJob));
  const pool = new LintPool(Math.min(workers, p.jobs.length));
  try {
    return p.finish(await pool.run(p.jobs));
  } finally {
    await pool.close();
  }
}

function prepare(req: Request): Prepared {
  const { cwd } = req;
  const bufferFile = req.buffer && path.resolve(cwd, req.buffer.file);
  let config: Config;
  try {
    config = loadConfig(req.config ?? findConfig(bufferFile ? path.dirname(bufferFile) : cwd), req.layer, cwd);
  } catch (e) {
    if (e instanceof ConfigError) throw new UsageError(e.message);
    throw e;
  }
  // A fix measured slower somewhere than maxSlowdown allows takes its rule out; unmeasured rules stay.
  const rules = allRules.filter((r) => IMPACT_RANK[r.impact] >= IMPACT_RANK[config.minImpact] && allowed(r.name, config.maxSlowdown));

  const files: string[] = [];
  const sources = new Map<string, string>();
  if (bufferFile) {
    if (!config.selects(bufferFile)) return { jobs: [], finish: () => ({ results: [], rules, config, errors: [], excluded: true, cached: 0 }) };
    files.push(bufferFile);
    sources.set(bufferFile, req.buffer!.text);
  } else {
    for (const p of req.paths?.length ? req.paths : ["."]) collect(p, cwd, files);
    files.splice(0, files.length, ...files.filter((f) => config.selects(f)).sort());
    if (!files.length) throw new UsageError("no JavaScript or TypeScript files found");
  }

  let profile: Profile | undefined;
  if (req.profiles?.length) {
    const paths = req.profiles.map((p) => path.resolve(cwd, p));
    try {
      profile = new Profile(paths, new Set(files));
    } catch (e) {
      throw new UsageError(`invalid --profile: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Each file belongs to the tsconfig nearest to it (in a monorepo, its package's), so lint per project.
  const resolver = new ProjectResolver(req.project && path.resolve(cwd, req.project));
  const byProject = new Map<Project, string[]>();
  for (const f of files) {
    const p = resolver.forFile(f);
    const group = byProject.get(p);
    if (group) group.push(f);
    else byProject.set(p, [f]);
  }
  const cache = req.cache && !req.fix && !bufferFile ? new LintCache(path.resolve(cwd, req.cache)) : undefined;
  const names = rules.map((r) => r.name);
  const jobs: Job[] = [];
  const hits: FileResult[] = [];
  const keys = new Map<string, string>();
  for (const [project, group] of byProject) {
    const job: Job = {
      files: group, rules: names, fix: req.fix, settings: group.map((f): [string, FileSettings] => [f, config.settingsFor(f)]),
      compilerOptions: project.options, extraRoots: project.ambient, sources: sources.size ? [...sources] : undefined,
    };
    if (!cache) {
      jobs.push(job);
      continue;
    }
    const plan = planCached(job, cache, cwd);
    hits.push(...plan.hits);
    for (const [f, k] of plan.keys) keys.set(f, k);
    if (plan.misses) jobs.push(plan.misses);
  }
  const finish = (done: JobResult[]): Run => {
    if (cache) {
      recordCached(cache, keys, done);
      cache.save();
    }
    const errors = new Set(done.flatMap((d) => d.errors.map((e) => `${e.rule} crashed on ${path.relative(cwd, e.file)}: ${e.message}`)));
    // A finding can be less important than its rule (a short chain outside a loop), so filter findings too.
    const min = IMPACT_RANK[config.minImpact];
    let results = [...hits, ...done.flatMap((d) => d.results)]
      .map((r) => (profile ? profile.annotate(r) : r))
      .map((r) => ({ ...r, findings: r.findings.filter((f) => IMPACT_RANK[f.impact] >= min) }));
    const order = new Map(files.map((f, i) => [f, i]));
    results.sort((a, b) => order.get(a.file)! - order.get(b.file)!);
    if (profile) results = byHeat(results);
    return { results, rules, config, errors: [...errors], excluded: false, cached: hits.length };
  };
  return { jobs, finish };
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
