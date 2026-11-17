import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const digest = (...parts: string[]) => {
  const h = crypto.createHash("sha1");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex");
};

/** What one file adds to the import graph; recomputed only when its mtime or size changes. */
export interface GraphNode {
  mtime: number;
  size: number;
  hash: string;
  /** A script, or a module with `declare global` / `declare module`: its declarations reach files that never import it. */
  global: boolean;
  /** `m:` module specifiers, `p:` reference paths, `t:` type references. */
  specs: string[];
}

export interface NodeSource {
  node(file: string): GraphNode | undefined;
  resolution(options: ts.CompilerOptions, cwd: string): ts.ModuleResolutionCache;
}

const JS = /\.[cm]?jsx?$/;
// As in TypeScript's binder, `require(...)`, `module.exports` or `exports.x =` make a JS file a CommonJS module.
const CJS = /\brequire\s*\(|\bmodule\.exports\b|\bexports\.[\w$]+\s*=/;

export function scanFile(file: string, text: string): Pick<GraphNode, "global" | "specs"> {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return { global: false, specs: [] };
  const info = ts.preProcessFile(text, true, true);
  const specs = [
    ...info.importedFiles.map((f) => `m:${f.fileName}`),
    ...info.referencedFiles.map((f) => `p:${f.fileName}`),
    ...info.typeReferenceDirectives.map((f) => `t:${f.fileName}`),
  ];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const augments = sf.statements.some((s) => ts.isModuleDeclaration(s) &&
    (ts.isStringLiteral(s.name) || (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0));
  const script = !ts.isExternalModule(sf) && !(JS.test(file) && CJS.test(text));
  return { global: script || augments, specs };
}

export interface Graph {
  /** Per file: its content, path and unresolved imports, plus the keys of everything it imports, transitively. */
  keys: Map<string, string>;
  /** Files whose declarations are global, which a partial program must still include. */
  globals: string[];
  /** One key over all of `globals`: a change to any of them can change every file's types. */
  globalKey: string;
}

/** Merkle keys over the import graph reachable from `roots`; import cycles share one key. */
export function importGraph(roots: readonly string[], options: ts.CompilerOptions, source: NodeSource, cwd: string): Graph {
  const modules = source.resolution(options, cwd);
  const node16 = options.moduleResolution === ts.ModuleResolutionKind.Node16 || options.moduleResolution === ts.ModuleResolutionKind.NodeNext;
  // Node16 resolves `import` and `require` differently, and the specifier list does not say which one a file uses.
  const modes = node16 ? [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS] as const : [undefined];
  const resolve = (spec: string, from: string): string[] => {
    const name = spec.slice(2);
    if (spec[0] === "p") {
      const p = path.resolve(path.dirname(from), name);
      return fs.existsSync(p) ? [p] : [];
    }
    const found = modes.map((mode) => spec[0] === "m"
      ? ts.resolveModuleName(name, from, options, ts.sys, modules, undefined, mode).resolvedModule?.resolvedFileName
      : ts.resolveTypeReferenceDirective(name, from, options, ts.sys, undefined, undefined, mode).resolvedTypeReferenceDirective?.resolvedFileName);
    return [...new Set(found.filter((f) => f !== undefined))];
  };

  const queue = [...roots];
  const inferred = path.join(options.configFilePath ? path.dirname(String(options.configFilePath)) : cwd, "__inferred type names__.ts");
  for (const name of ts.getAutomaticTypeDirectiveNames(options, ts.sys)) queue.push(...resolve(`t:${name}`, inferred));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, string[]>();
  const loose = new Map<string, string[]>();
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!;
    if (nodes.has(file)) continue;
    const node = source.node(file);
    if (!node) continue;
    nodes.set(file, node);
    const out: string[] = [];
    const missing: string[] = [];
    for (const spec of node.specs) {
      const found = resolve(spec, file);
      if (found.length) out.push(...found);
      else missing.push(spec);
    }
    edges.set(file, out);
    loose.set(file, missing.sort());
    queue.push(...out);
  }

  const own = (f: string) => digest(f, nodes.get(f)!.hash, ...loose.get(f)!);
  const component = new Map<string, number>();
  const componentKeys: string[] = [];
  const linked = (f: string) => edges.get(f)!.filter((e) => nodes.has(e));
  for (const members of components([...nodes.keys()], linked)) {
    const inside = new Set(members);
    const children = new Set<string>();
    for (const m of members) for (const e of linked(m)) if (!inside.has(e)) children.add(componentKeys[component.get(e)!]!);
    for (const m of members) component.set(m, componentKeys.length);
    componentKeys.push(digest(...members.map(own).sort(), "|", ...[...children].sort()));
  }
  const keys = new Map([...nodes.keys()].map((f) => [f, componentKeys[component.get(f)!]!]));
  const globals = [...nodes].filter(([, n]) => n.global).map(([f]) => f);
  return { keys, globals, globalKey: digest(...globals.map((f) => keys.get(f)!).sort()) };
}

/** Strongly connected components (Tarjan, iterative), each after every component it reaches. */
function components(nodes: readonly string[], edges: (n: string) => string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const enter = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
  };
  for (const root of nodes) {
    if (index.has(root)) continue;
    enter(root);
    const work: [string, string[], number][] = [[root, edges(root), 0]];
    while (work.length) {
      const top = work[work.length - 1]!;
      const [v, next, i] = top;
      if (i < next.length) {
        top[2]++;
        const w = next[i]!;
        if (!index.has(w)) {
          enter(w);
          work.push([w, edges(w), 0]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent[0], Math.min(low.get(parent[0])!, low.get(v)!));
      if (low.get(v) !== index.get(v)) continue;
      const members: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        members.push(w);
      } while (w !== v);
      out.push(members);
    }
  }
  return out;
}
