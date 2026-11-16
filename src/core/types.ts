import type ts from "typescript";

export type Impact = "high" | "medium" | "low";
/** Type knowledge: "maybe" means the type is any/unknown; a union with any non-matching member is "no". */
export type Tri = "yes" | "no" | "maybe";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * What a fix guarantees. exact: same behaviour for every input. typed: for every input the types and
 * optilint's analysis allow (arrays are taken to be dense). assumed: only if `assumes` holds.
 */
export type Tier = "exact" | "typed" | "assumed";
export type Severity = "info" | "warn" | "error";

export interface Fix {
  edits: Edit[];
  tier: Tier;
  /** For the assumed tier: what the fix takes on trust. */
  assumes?: string;
  /** Correct for its tier but hard to read, e.g. `x | 0`; applied in bulk only when configured. */
  obscure?: boolean;
}

export interface Finding {
  rule: string;
  group: string;
  impact: Impact;
  /** Set when the config gives the rule a level; otherwise derive one from `impact`. */
  severity?: Severity;
  message: string;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** UTF-16 offsets into the text that was linted, like `fix.edits`. */
  start: number;
  end: number;
  fix?: Fix;
}

export interface Rule {
  name: string;
  impact: Impact;
  /** The tiers its fixes can have; empty when it only reports. */
  tiers: readonly Tier[];
  /** Off unless enabled, under the "recommended" preset. */
  recommended?: false;
  /** Its fixes are obscure (see Fix). */
  obscure?: true;
  /** Why it never runs, usually a measured loss (`bench/FINDINGS.md`). Its code, tests and bench case stay, so a
   * later bench run can bring it back. */
  retired?: string;
  group: string;
  description: string;
  why: string;
  kinds: ts.SyntaxKind[];
  check(node: ts.Node, ctx: RuleContext): void;
}

/** A rule as written in src/rules; the group comes from the file it is registered under. */
export type RuleDef = Omit<Rule, "group">;

export interface RuleContext {
  readonly ts: typeof ts;
  readonly sf: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly isTS: boolean;
  readonly options: ts.CompilerOptions;
  report(node: ts.Node, message: string, fix?: Fix): void;
  text(node: ts.Node): string;
  replace(node: ts.Node, text: string): Edit;
  isArray(expr: ts.Expression): Tri;
  isString(expr: ts.Expression): Tri;
  isType(expr: ts.Expression, name: string): Tri;
  /** Whether the project's lib declares `name` on `expr`'s type (e.g. replaceAll needs ES2021). */
  hasMember(expr: ts.Expression, name: string): boolean;
  /** A fresh identifier; pass `at` (where the name is declared) to only avoid names in its function. */
  uniqueName(base: string, at?: ts.Node): string;
  quote(value: string): string;
  indentOf(node: ts.Node): string;
}
