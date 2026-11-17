import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { type FileResult, type FileSettings, programOptions } from "./core/engine.ts";
import type { Finding } from "./core/types.ts";
import { digest, type GraphNode, importGraph, scanFile } from "./graph.ts";
import type { Job, JobResult } from "./job.ts";
import { TOOL } from "./report.ts";

const FORMAT = 1;

interface Entry {
  key: string;
  findings: Finding[];
}

interface Stored {
  format: number;
  /** optilint and TypeScript versions; a cache from other versions is dropped whole. */
  version: string;
  nodes: Record<string, GraphNode>;
  entries: Record<string, Entry>;
}

/** `node_modules/.cache/optilint/` when there is a `node_modules`, as other tools do; else `.optilintcache`. */
export function defaultCacheLocation(cwd: string) {
  const modules = path.join(cwd, "node_modules");
  return fs.existsSync(modules) ? path.join(modules, ".cache", "optilint", "cache.json") : path.join(cwd, ".optilintcache");
}

/** Findings per file, valid while the file's import-graph key is unchanged. */
export class LintCache {
  readonly version = `${TOOL.version}/${ts.version}`;
  private readonly stored: Stored;
  private readonly seen = new Map<string, GraphNode | undefined>();
  private readonly resolutions = new Map<string, ts.ModuleResolutionCache>();

  constructor(readonly location: string) {
    let s: Stored | undefined;
    try {
      s = JSON.parse(fs.readFileSync(location, "utf8")) as Stored;
    } catch {}
    this.stored = s?.format === FORMAT && s.version === this.version ? s : { format: FORMAT, version: this.version, nodes: {}, entries: {} };
  }

  node(file: string): GraphNode | undefined {
    if (this.seen.has(file)) return this.seen.get(file);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    let node = st?.isFile() ? this.stored.nodes[file] : undefined;
    if (st?.isFile() && (node?.mtime !== st.mtimeMs || node.size !== st.size)) {
      const text = fs.readFileSync(file, "utf8");
      node = this.stored.nodes[file] = { mtime: st.mtimeMs, size: st.size, hash: digest(text), ...scanFile(file, text) };
    }
    this.seen.set(file, node);
    return node;
  }

  /** One module resolution cache for all projects with the same options, as most packages of a monorepo have. */
  resolution(options: ts.CompilerOptions, cwd: string): ts.ModuleResolutionCache {
    const { configFilePath: _, ...rest } = options;
    const key = JSON.stringify(rest);
    let cache = this.resolutions.get(key);
    if (!cache) {
      const canon = (s: string) => (ts.sys.useCaseSensitiveFileNames ? s : s.toLowerCase());
      this.resolutions.set(key, (cache = ts.createModuleResolutionCache(cwd, canon, rest)));
    }
    return cache;
  }

  findings(file: string, key: string): Finding[] | undefined {
    const e = this.stored.entries[file];
    return e?.key === key ? e.findings : undefined;
  }

  store(file: string, key: string, findings: Finding[]) {
    this.stored.entries[file] = { key, findings };
  }

  /** Writes the cache, forgetting files that no longer exist. */
  save() {
    for (const table of [this.stored.nodes, this.stored.entries]) {
      for (const f of Object.keys(table)) if (!this.seen.has(f) && !fs.existsSync(f)) delete table[f];
    }
    fs.mkdirSync(path.dirname(this.location), { recursive: true });
    const tmp = `${this.location}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.stored));
    fs.renameSync(tmp, this.location);
  }
}

const settingsKey = (s?: FileSettings) => JSON.stringify(s ? [s.tier, s.obscure, s.rules ? [...s.rules] : null] : null);

export interface CachePlan {
  /** Files whose stored findings still hold. */
  hits: FileResult[];
  /** The job for the rest, if any. */
  misses?: Job;
  /** Each file's key, to store its findings under once linted. */
  keys: Map<string, string>;
}

/** Splits a report-mode job into the files the cache answers and a job for the others. */
export function planCached(job: Job, cache: LintCache, cwd: string): CachePlan {
  const options = programOptions(job.compilerOptions);
  const graph = importGraph([...job.files, ...job.extraRoots], options, cache, cwd);
  const base = digest(cache.version, JSON.stringify(options), job.rules.join(","), graph.globalKey);
  const settings = new Map(job.settings);
  const keys = new Map(job.files.map((f) => [f, digest(base, graph.keys.get(f) ?? "", settingsKey(settings.get(f)))]));
  const hits: FileResult[] = [];
  const misses: string[] = [];
  for (const file of job.files) {
    const findings = cache.findings(file, keys.get(file)!);
    if (!findings) {
      misses.push(file);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    hits.push({ file, original: text, output: text, findings, fixesApplied: 0 });
  }
  if (!misses.length) return { hits, keys };
  // Global declarations in files that hit still shape the types of the files that missed.
  const extraRoots = [...new Set([...job.extraRoots, ...graph.globals])];
  const missing = new Set(misses);
  return { hits, keys, misses: { ...job, files: misses, settings: job.settings.filter(([f]) => missing.has(f)), extraRoots } };
}

/** Stores the findings of linted files, except where a rule crashed. */
export function recordCached(cache: LintCache, keys: ReadonlyMap<string, string>, done: readonly JobResult[]) {
  for (const { results, errors } of done) {
    const crashed = new Set(errors.map((e) => e.file));
    for (const r of results) {
      const key = keys.get(r.file);
      if (key && !crashed.has(r.file)) cache.store(r.file, key, r.findings);
    }
  }
}
