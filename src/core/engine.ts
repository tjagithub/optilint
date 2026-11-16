import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { FileContext } from "./context.ts";
import { maxTier, tierRank } from "./fix.ts";
import { DEFAULT_OPTIONS } from "./project.ts";
import type { Edit, Finding, Rule, Severity, Tier } from "./types.ts";

export interface RuleSetting {
  severity?: Severity;
  /** Raise this rule's fixes to at least this tier, or drop them ("none"). */
  floor?: Tier | "none";
}

/** What the config says for one file. */
export interface FileSettings {
  /** The rules that run (a subset of LintOptions.rules); all of them when absent. */
  rules?: ReadonlyMap<string, RuleSetting>;
  /** The highest tier --fix applies. */
  tier: Tier;
  /** Whether --fix applies obscure fixes. */
  obscure: boolean;
}

export const DEFAULT_SETTINGS: FileSettings = { tier: "typed", obscure: false };

export interface LintOptions {
  rules: readonly Rule[];
  fix?: boolean;
  settings?: (file: string) => FileSettings;
  compilerOptions?: ts.CompilerOptions;
  /** Extra program roots (ambient .d.ts files) that are type-checked but not linted. */
  extraRoots?: readonly string[];
  maxPasses?: number;
  onRuleError?: (rule: string, file: string, error: unknown) => void;
}

export interface FileResult {
  file: string;
  original: string;
  output: string;
  findings: Finding[];
  fixesApplied: number;
}

/** Lint (and optionally fix) files. `sources` overrides file contents, e.g. for tests or stdin. */
export function lint(files: readonly string[], opts: LintOptions, sources = new Map<string, string>()): FileResult[] {
  const options: ts.CompilerOptions = {
    ...DEFAULT_OPTIONS, ...opts.compilerOptions, noEmit: true, allowJs: true, checkJs: false,
  };
  const overlay = new Map(sources);
  const host = cachingHost(options, overlay);
  const results = new Map<string, FileResult>();
  for (const file of files) {
    const text = overlay.get(file) ?? ts.sys.readFile(file) ?? "";
    overlay.set(file, text);
    results.set(file, { file, original: text, output: text, findings: [], fixesApplied: 0 });
  }
  const roots = [...new Set([...files, ...(opts.extraRoots ?? [])])];
  const maxPasses = opts.maxPasses ?? 10;
  const table = dispatchTable(opts.rules);
  const settings = new Map(files.map((f) => [f, opts.settings?.(f) ?? DEFAULT_SETTINGS]));
  let program: ts.Program | undefined;
  let dirty = new Set(files);
  for (let pass = 0; dirty.size; pass++) {
    program = ts.createProgram({ rootNames: roots, options, host, oldProgram: program });
    const checker = program.getTypeChecker();
    const next = new Set<string>();
    for (const file of dirty) {
      const sf = program.getSourceFile(file);
      const result = results.get(file)!;
      if (!sf) continue;
      const s = settings.get(file)!;
      result.findings = runRules(sf, checker, options, table, s, opts.onRuleError);
      if (!opts.fix || pass >= maxPasses) continue;
      const fixes = result.findings.filter((f) => f.fix && applies(f.fix, s));
      const { text, applied } = applyFixes(sf.text, fixes);
      if (!applied) continue;
      overlay.set(file, text);
      result.output = text;
      result.fixesApplied += applied;
      next.add(file);
    }
    dirty = next;
  }
  return [...results.values()];
}

type Table = Map<ts.SyntaxKind, Rule[]>;

function dispatchTable(rules: readonly Rule[]): Table {
  const table: Table = new Map();
  for (const rule of rules) {
    for (const kind of rule.kinds) {
      const list = table.get(kind);
      if (list) list.push(rule);
      else table.set(kind, [rule]);
    }
  }
  return table;
}

export const applies = (fix: NonNullable<Finding["fix"]>, s: FileSettings) =>
  tierRank(fix.tier) <= tierRank(s.tier) && (!fix.obscure || s.obscure);

function configure(f: Finding, setting: RuleSetting | undefined): Finding {
  if (setting?.severity) f.severity = setting.severity;
  const floor = setting?.floor;
  if (!f.fix || !floor) return f;
  if (floor === "none") delete f.fix;
  else f.fix = { ...f.fix, tier: maxTier(f.fix.tier, floor) };
  return f;
}

function runRules(
  sf: ts.SourceFile, checker: ts.TypeChecker, options: ts.CompilerOptions, table: Table, s: FileSettings,
  onError?: LintOptions["onRuleError"],
): Finding[] {
  const ctx = new FileContext(sf, checker, options);
  const visit = (node: ts.Node): void => {
    const rules = table.get(node.kind);
    if (rules) {
      for (const rule of rules) {
        if (s.rules && !s.rules.has(rule.name)) continue;
        ctx.rule = rule;
        try {
          rule.check(node, ctx);
        } catch (error) {
          onError?.(rule.name, sf.fileName, error);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ctx.findings.map((f) => configure(f, s.rules?.get(f.rule))).sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule));
}

/** Apply non-overlapping fixes in one go; overlapping ones wait for the next pass. */
export function applyFixes(text: string, findings: readonly Finding[]) {
  const accepted: Edit[] = [];
  let applied = 0;
  const overlaps = (a: Edit, b: Edit) => (a.start < b.end && b.start < a.end) || a.start === b.start;
  for (const f of findings) {
    const edits = f.fix?.edits ?? [];
    if (!edits.length || edits.some((e) => accepted.some((a) => overlaps(a, e)))) continue;
    accepted.push(...edits);
    applied++;
  }
  accepted.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of accepted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, applied };
}

/** Files on disk are parsed again only when their mtime changes (the MCP server runs for long); linted files come from the overlay. */
const diskCache = new Map<string, { mtime: number; sf: ts.SourceFile | undefined }>();

/** Caches parsed files so later passes reuse the previous program (lib.d.ts parsing dominates). */
function cachingHost(options: ts.CompilerOptions, overlay: Map<string, string>): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const disk = diskCache;
  const virtual = new Map<string, ts.SourceFile>();
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, lang, onError, create) => {
    const text = overlay.get(name);
    if (text !== undefined) {
      const cached = virtual.get(name);
      if (cached?.text === text) return cached;
      const sf = ts.createSourceFile(name, text, lang, true, scriptKind(name));
      virtual.set(name, sf);
      return sf;
    }
    const mtime = fs.statSync(name, { throwIfNoEntry: false })?.mtimeMs ?? -1;
    let hit = disk.get(name);
    if (hit?.mtime !== mtime) disk.set(name, (hit = { mtime, sf: getSourceFile(name, lang, onError, create) }));
    return hit.sf;
  };
  host.readFile = (name) => overlay.get(name) ?? readFile(name);
  host.fileExists = (name) => overlay.has(name) || fileExists(name);
  return host;
}

function scriptKind(name: string) {
  const ext = path.extname(name);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
