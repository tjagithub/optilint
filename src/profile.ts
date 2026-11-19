// `--profile`: ranks findings by how much CPU time a V8 / Chrome `.cpuprofile` spent in the function holding them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { FileResult } from "./core/engine.ts";
import type { Finding } from "./core/types.ts";
import { loadSourceMap, type Original, type SourceMap } from "./sourcemap.ts";

interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

/** A function the profile saw, at the 0-based position of its parameter list. */
interface Seen { line: number; col: number; name: string; time: number }

const IDLE = new Set(["(idle)", "(root)"]);

function parse(file: string): CpuProfile {
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CpuProfile>;
  if (!Array.isArray(json.nodes) || !Array.isArray(json.samples) || !Array.isArray(json.timeDeltas)) {
    throw new Error("not a .cpuprofile (wants nodes, samples and timeDeltas, as node --cpu-prof writes)");
  }
  return json as CpuProfile;
}

/** CPU time per linted function, from one or more profiles. */
export class Profile {
  private readonly byFile = new Map<string, Seen[]>();
  private total = 0;

  /** `linted` are the files being linted; time in anything else counts toward the linted function that called it. */
  constructor(files: readonly string[], linted: ReadonlySet<string>) {
    const maps = new Map<string, SourceMap | undefined>();
    for (const file of files) this.add(parse(file), linted, maps);
    if (!this.total) throw new Error("the profile has no samples");
  }

  private add(p: CpuProfile, linted: ReadonlySet<string>, maps: Map<string, SourceMap | undefined>) {
    const parent = new Map<number, ProfileNode>();
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n);
    const weight = new Map<number, number>();
    for (let i = 0; i < p.samples.length; i++) {
      const id = p.samples[i]!;
      const node = byId.get(id);
      if (!node || IDLE.has(node.callFrame.functionName)) continue;
      // Each delta is the time since the sample before; a sample stands for the interval that ends at it.
      const dt = Math.max(0, p.timeDeltas[i] ?? 0);
      weight.set(id, (weight.get(id) ?? 0) + dt);
      this.total += dt;
    }
    const owner = new Map<number, Seen | null>();
    const ownerOf = (n: ProfileNode): Seen | null => {
      const known = owner.get(n.id);
      if (known !== undefined) return known;
      let at = this.locate(n.callFrame, linted, maps);
      // Bun names top-level code `(module)` and places it at its first statement; V8 uses 0:0, as functionStart does.
      if (at && n.callFrame.functionName === "(module)") at = { ...at, line: 0, col: 0 };
      const up = parent.get(n.id);
      const found = at ? this.seen(at, n.callFrame.functionName) : up ? ownerOf(up) : null;
      owner.set(n.id, found);
      return found;
    };
    for (const [id, time] of weight) {
      const seen = ownerOf(byId.get(id)!);
      if (seen) seen.time += time;
    }
  }

  /** The linted source position of a frame, through a source map when its script has one. */
  private locate(f: CallFrame, linted: ReadonlySet<string>, maps: Map<string, SourceMap | undefined>): Original | undefined {
    if (!f.url || f.lineNumber < 0) return undefined;
    let file: string;
    try {
      file = f.url.startsWith("file://") ? fileURLToPath(f.url) : path.isAbsolute(f.url) ? f.url : "";
    } catch {
      return undefined;
    }
    if (!file) return undefined;
    if (linted.has(file)) return { file, line: f.lineNumber, col: f.columnNumber };
    if (!maps.has(file)) maps.set(file, loadSourceMap(file));
    const o = maps.get(file)?.original(f.lineNumber, f.columnNumber);
    return o && linted.has(o.file) ? o : undefined;
  }

  private seen(at: Original, name: string): Seen {
    let list = this.byFile.get(at.file);
    if (!list) this.byFile.set(at.file, (list = []));
    let s = list.find((x) => x.line === at.line && x.col === at.col);
    if (!s) list.push((s = { line: at.line, col: at.col, name, time: 0 }));
    return s;
  }

  /** Share of profiled time in the function at (line, col). A source map or another engine can place a function
   * a few columns off, so a line with just one function the profile saw matches that one. */
  private share(file: string, line: number, col: number): number {
    const list = this.byFile.get(file)?.filter((s) => s.line === line) ?? [];
    const hit = list.find((s) => s.col === col) ?? (list.length === 1 ? list[0] : undefined);
    return hit ? hit.time / this.total : 0;
  }

  /** Sets each finding's `cpu`; findings in functions the profile never saw drop to low impact. */
  annotate(r: FileResult): FileResult {
    if (!r.findings.length) return r;
    const sf = ts.createSourceFile(r.file, r.original, ts.ScriptTarget.Latest, true);
    const findings = r.findings.map((f): Finding => {
      const [line, col] = functionStart(sf, f.start);
      const cpu = this.share(r.file, line, col);
      return { ...f, cpu, ...(cpu === 0 ? { impact: "low" as const } : {}) };
    });
    findings.sort((a, b) => b.cpu! - a.cpu! || a.start - b.start);
    return { ...r, findings };
  }
}

/** Where V8 places the innermost function around `pos`: its parameter list's `(` (or lone parameter), as 0-based
 * line and column. Module top-level code is 0:0. */
function functionStart(sf: ts.SourceFile, pos: number): [number, number] {
  let fn: ts.FunctionLikeDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && "body" in n && n.body) fn = n as ts.FunctionLikeDeclaration;
    ts.forEachChild(n, (c) => (c.pos <= pos && pos < c.end ? (visit(c), true) : undefined));
  };
  visit(sf);
  if (!fn) return [0, 0];
  const paren = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.OpenParenToken);
  const at = paren ? paren.getStart(sf) : (fn.parameters[0]?.getStart(sf) ?? fn.getStart(sf));
  const { line, character } = sf.getLineAndCharacterOfPosition(at);
  return [line, character];
}

/** Hottest files first (by their hottest finding); files the profile never reached keep their place after them. */
export function byHeat(results: FileResult[]): FileResult[] {
  const heat = (r: FileResult) => r.findings.reduce((m, f) => Math.max(m, f.cpu ?? 0), 0);
  return results.map((r, i) => ({ r, i, h: heat(r) })).sort((a, b) => b.h - a.h || a.i - b.i).map((x) => x.r);
}
