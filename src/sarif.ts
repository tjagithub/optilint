import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FileResult } from "./core/engine.ts";
import { TOOL } from "./report.ts";
import type { Finding, Rule } from "./core/types.ts";

const LEVEL = { error: "error", warn: "warning", info: "note" } as const;
const IMPACT_LEVEL = { high: "warning", medium: "warning", low: "note" } as const;

// Relative URIs against %SRCROOT% let GitHub code scanning map results onto the repository.
function artifact(file: string, cwd: string) {
  const rel = path.relative(cwd, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { uri: pathToFileURL(file).href };
  return { uri: rel.split(path.sep).map(encodeURIComponent).join("/"), uriBaseId: "%SRCROOT%" };
}

function result(f: Finding, index: Map<string, number>, cwd: string, describe: (rule: string) => string | undefined) {
  const location = artifact(f.file, cwd);
  return {
    ruleId: f.rule,
    ruleIndex: index.get(f.rule),
    level: f.severity ? LEVEL[f.severity] : IMPACT_LEVEL[f.impact],
    message: { text: f.message },
    locations: [{
      physicalLocation: {
        artifactLocation: location,
        region: { startLine: f.line, startColumn: f.col, endLine: f.endLine, endColumn: f.endCol, charOffset: f.start, charLength: f.end - f.start },
      },
    }],
    ...(f.fix ? {
      fixes: [{
        description: { text: `${describe(f.rule) ?? f.rule} (tier: ${f.fix.tier}${f.fix.assumes ? `; assumes ${f.fix.assumes}` : ""})` },
        artifactChanges: [{
          artifactLocation: location,
          replacements: f.fix.edits.map((e) => ({
            deletedRegion: { charOffset: e.start, charLength: e.end - e.start },
            insertedContent: { text: e.text },
          })),
        }],
      }],
    } : {}),
    properties: {
      impact: f.impact, group: f.group, ...(f.cpu !== undefined ? { cpu: f.cpu } : {}),
      ...(f.fix ? { tier: f.fix.tier, ...(f.fix.assumes ? { assumes: f.fix.assumes } : {}), ...(f.fix.obscure ? { obscure: true } : {}) } : {}),
    },
  };
}

/** SARIF 2.1.0, with columns and offsets in UTF-16 code units like the JSON output. */
export function formatSarif(results: readonly FileResult[], rules: readonly Rule[], cwd: string) {
  const index = new Map(rules.map((r, i) => [r.name, i]));
  const describe = (name: string) => rules[index.get(name) ?? -1]?.description;
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: TOOL.name, version: TOOL.version, semanticVersion: TOOL.version,
          rules: rules.map((r) => ({
            id: r.name,
            shortDescription: { text: r.description },
            fullDescription: { text: r.why },
            defaultConfiguration: { level: IMPACT_LEVEL[r.impact], enabled: r.recommended !== false },
            properties: { impact: r.impact, group: r.group, tiers: r.tiers, tags: ["performance"] },
          })),
        },
      },
      columnKind: "utf16CodeUnits",
      originalUriBaseIds: { "%SRCROOT%": { uri: pathToFileURL(cwd + path.sep).href } },
      results: results.flatMap((r) => r.findings.map((f) => result(f, index, cwd, describe))),
    }],
  }, null, 2);
}
