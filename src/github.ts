import path from "node:path";
import type { FileResult } from "./core/engine.ts";
import type { Finding } from "./core/types.ts";

// GitHub Actions workflow commands: each line becomes an annotation on the run and on the PR diff.
const LEVEL = { error: "error", warn: "warning", info: "notice" } as const;
const IMPACT_LEVEL = { high: "warning", medium: "warning", low: "notice" } as const;

const data = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const prop = (s: string) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function command(f: Finding, cwd: string) {
  const rel = path.relative(cwd, f.file);
  const file = rel.startsWith("..") || path.isAbsolute(rel) ? f.file : rel.split(path.sep).join("/");
  const props = [
    `file=${prop(file)}`, `line=${f.line}`, `col=${f.col}`, `endLine=${f.endLine}`, `endColumn=${f.endCol}`,
    `title=${prop(`optilint ${f.rule}`)}`,
  ];
  const fix = f.fix ? ` [fix: ${f.fix.tier}${f.fix.assumes ? `, assumes ${f.fix.assumes}` : ""}]` : "";
  return `::${f.severity ? LEVEL[f.severity] : IMPACT_LEVEL[f.impact]} ${props.join(",")}::${data(f.message + fix)}`;
}

export function formatGithub(results: readonly FileResult[], cwd: string) {
  return results.flatMap((r) => r.findings.map((f) => command(f, cwd))).join("\n");
}
