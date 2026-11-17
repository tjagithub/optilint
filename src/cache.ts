import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { type FileResult, type FileSettings, lint, type LintOptions, programOptions } from "./core/engine.ts";
import type { Finding } from "./core/types.ts";
import { digest, type GraphNode, importGraph, scanFile } from "./graph.ts";
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

/** `lint` without fixes, reusing stored findings for every file whose key is unchanged. */
export function lintCached(files: readonly string[], opts: LintOptions, cache: LintCache, cwd: string) {
  const options = programOptions(opts.compilerOptions);
  const extra = opts.extraRoots ?? [];
  const graph = importGraph([...files, ...extra], options, cache, cwd);
  const base = digest(cache.version, JSON.stringify(options), opts.rules.map((r) => r.name).join(","), graph.globalKey);
  const keys = new Map(files.map((f) => [f, digest(base, graph.keys.get(f) ?? "", settingsKey(opts.settings?.(f)))]));
  const results: FileResult[] = [];
  const misses: string[] = [];
  for (const file of files) {
    const findings = cache.findings(file, keys.get(file)!);
    if (!findings) {
      misses.push(file);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    results.push({ file, original: text, output: text, findings, fixesApplied: 0 });
  }
  if (misses.length) {
    // Global declarations in files that hit still shape the types of the files that missed.
    const crashed = new Set<string>();
    const fresh = lint(misses, {
      ...opts, fix: false, extraRoots: [...new Set([...extra, ...graph.globals])],
      onRuleError: (rule, file, e) => {
        crashed.add(file);
        opts.onRuleError?.(rule, file, e);
      },
    });
    for (const r of fresh) if (!crashed.has(r.file)) cache.store(r.file, keys.get(r.file)!, r.findings);
    results.push(...fresh);
  }
  return { results, hits: files.length - misses.length };
}
