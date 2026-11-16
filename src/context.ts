import ts from "typescript";
import type { Edit, Finding, Fix, Rule, RuleContext, Tri } from "./types.ts";

const TYPED_ARRAYS = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array",
]);
const DIRECTIVE = /optilint-disable(-next-line|-line|-file)?\b([^\n*]*)/g;

export class FileContext implements RuleContext {
  readonly ts = ts;
  readonly findings: Finding[] = [];
  readonly isTS: boolean;
  rule!: Rule;
  private names?: Set<string>;
  private moduleNames = new Set<string>();
  private scopeNames = new Map<ts.Node, Set<string>>();
  private quoteChar?: string;
  private disabledLines = new Map<number, Set<string> | "all">();
  private disabledFile: Set<string> | "all" | undefined;

  constructor(
    readonly sf: ts.SourceFile,
    readonly checker: ts.TypeChecker,
    readonly options: ts.CompilerOptions,
  ) {
    this.isTS = /\.[cm]?tsx?$/.test(sf.fileName);
    this.parseDirectives();
  }

  private parseDirectives() {
    const text = this.sf.text;
    if (!text.includes("optilint-disable")) return;
    for (const m of text.matchAll(DIRECTIVE)) {
      const list = (m[2] ?? "").split(/[\s,]+/).filter((r) => /^[a-z0-9-]+$/.test(r));
      const rules: Set<string> | "all" = list.length ? new Set(list) : "all";
      const { line } = this.sf.getLineAndCharacterOfPosition(m.index);
      if (m[1] === "-file") this.disabledFile = merge(this.disabledFile, rules);
      else {
        const target = m[1] === "-line" ? line : line + 1;
        this.disabledLines.set(target, merge(this.disabledLines.get(target), rules));
      }
    }
  }

  private isDisabled(line: number, rule: string) {
    const hit = (s?: Set<string> | "all") => s === "all" || !!s?.has(rule);
    return hit(this.disabledFile) || hit(this.disabledLines.get(line));
  }

  report(node: ts.Node, message: string, fix?: Fix) {
    const start = node.getStart(this.sf);
    const { line, character } = this.sf.getLineAndCharacterOfPosition(start);
    if (this.isDisabled(line, this.rule.name)) return;
    const endPos = this.sf.getLineAndCharacterOfPosition(node.end);
    this.findings.push({
      rule: this.rule.name, group: this.rule.group, impact: this.rule.impact, message,
      file: this.sf.fileName, line: line + 1, col: character + 1,
      endLine: endPos.line + 1, endCol: endPos.character + 1,
      start, end: node.end, fix,
    });
  }

  text(node: ts.Node) {
    return node.getText(this.sf);
  }

  replace(node: ts.Node, text: string): Edit {
    return { start: node.getStart(this.sf), end: node.end, text };
  }

  private classify(expr: ts.Expression, pred: (t: ts.Type) => boolean): Tri {
    let type = this.checker.getTypeAtLocation(expr);
    if (type.flags & ts.TypeFlags.TypeParameter) {
      type = this.checker.getBaseConstraintOfType(type) ?? type;
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
      return "maybe";
    }
    const parts = type.isUnion() ? type.types : [type];
    const hits = parts.filter(pred).length;
    return hits === parts.length ? "yes" : "no";
  }

  isArray(expr: ts.Expression): Tri {
    return this.classify(expr, (t) =>
      this.checker.isArrayType(t) || this.checker.isTupleType(t) ||
      TYPED_ARRAYS.has(t.getSymbol()?.getName() ?? ""));
  }

  isString(expr: ts.Expression): Tri {
    return this.classify(expr, (t) => !!(t.flags & ts.TypeFlags.StringLike));
  }

  isType(expr: ts.Expression, name: string): Tri {
    return this.classify(expr, (t) => t.getSymbol()?.getName() === name);
  }

  hasMember(expr: ts.Expression, name: string) {
    const type = this.checker.getApparentType(this.checker.getTypeAtLocation(expr));
    if (type.flags & ts.TypeFlags.Any) return true;
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((t) => this.checker.getPropertyOfType(this.checker.getApparentType(t), name) !== undefined);
  }

  // Inside a function, a name only has to be free in that function (and of module-level names handed out),
  // so separate functions each get `len`. Without `at`, or at top level, it must be free in the whole file.
  uniqueName(base: string, at?: ts.Node) {
    this.names ??= identifiers(this.sf.text);
    const scope = at && ts.findAncestor(at, ts.isFunctionLike);
    let taken = this.names;
    if (scope) {
      taken = this.scopeNames.get(scope) ?? identifiers(scope.getText(this.sf));
      this.scopeNames.set(scope, taken);
    }
    let name = base;
    for (let n = 2; taken.has(name) || this.moduleNames.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    this.names.add(name);
    if (!scope) this.moduleNames.add(name);
    return name;
  }

  quote(value: string) {
    if (!this.quoteChar) {
      const t = this.sf.text;
      const single = t.split("'").length;
      this.quoteChar = single > t.split('"').length ? "'" : '"';
    }
    const json = JSON.stringify(value);
    if (this.quoteChar === '"') return json;
    return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
  }

  indentOf(node: ts.Node) {
    const start = node.getStart(this.sf);
    const lineStart = this.sf.text.lastIndexOf("\n", start - 1) + 1;
    return /^[ \t]*/.exec(this.sf.text.slice(lineStart, start))?.[0] ?? "";
  }
}

const identifiers = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);

function merge(a: Set<string> | "all" | undefined, b: Set<string> | "all") {
  if (a === "all" || b === "all") return "all";
  return a ? new Set([...a, ...b]) : b;
}
