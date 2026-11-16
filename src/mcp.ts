// `optilint --mcp`: a Model Context Protocol server, newline-delimited JSON-RPC 2.0 on stdio.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { FileResult } from "./core/engine.ts";
import { TIERS } from "./core/fix.ts";
import { formatExplain, TOOL } from "./report.ts";
import { allRules, retiredByName, ruleByName } from "./rules/index.ts";
import { layer, type Request, run, unifiedDiff, UsageError } from "./runner.ts";
import type { Finding } from "./core/types.ts";
import { IMPACTS, validateNames } from "./validate.ts";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_DIFF = 100_000;

const INSTRUCTIONS = `optilint finds performance problems in JavaScript and TypeScript, type-checked with the TypeScript compiler.
Every fix has a tier: "exact" (same behaviour for every input), "typed" (for every input the types allow) or "assumed" (only if its "assumes" text holds).
Apply exact and typed fixes freely. Before applying an assumed fix, check its assumption against the code. Findings without a fix are advice: change that code only when it is hot or measured.`;

const str = (description: string) => ({ type: "string", description });
const target = {
  paths: { type: "array", items: { type: "string" }, description: "Files or directories, relative to the server's working directory. Default: all of it." },
  code: str("Source text to check instead of files on disk. Imports resolve against the files on disk."),
  filename: str("The path `code` would have; it decides JS, TS or JSX and which config applies. Default: snippet.ts."),
  rules: { type: "array", items: { type: "string" }, description: "Only these rules or groups." },
};
const object = (properties: object, required?: string[]) => ({ type: "object", properties, additionalProperties: false, ...(required ? { required } : {}) });

export const TOOLS = [
  {
    name: "lint",
    title: "Find performance problems",
    description: "Reports performance findings for files or a code snippet. Each finding names its rule, impact and, when it has a fix, the fix's tier and what an assumed fix assumes.",
    inputSchema: object({ ...target, minImpact: { type: "string", enum: IMPACTS, description: "Hide findings with less impact. Default: the config's." } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fix",
    title: "Fix performance problems",
    description: "Applies fixes up to a tier over several passes. For `code`, returns the fixed text. For files, returns a unified diff and writes only with `write: true`.",
    inputSchema: object({
      ...target,
      tier: { type: "string", enum: TIERS, description: "The highest tier to apply. Default: the config's (normally typed)." },
      obscure: { type: "boolean", description: "Also apply fixes that are correct but hard to read." },
      write: { type: "boolean", description: "Write the fixed files. Default false: return the diff only." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "rules",
    title: "Explain optilint rules",
    description: "Explains one rule (what it finds, why it is slow, its fix tiers), or lists every rule without `rule`.",
    inputSchema: object({ rule: str("The rule to explain.") }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

interface Args {
  paths?: string[];
  code?: string;
  filename?: string;
  rules?: string[];
  minImpact?: string;
  tier?: string;
  obscure?: boolean;
  write?: boolean;
  rule?: string;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

// Tools read and write only below the directory the server runs in.
function inside(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new UsageError(`${p} is outside ${root}`);
  return abs;
}

function request(root: string, a: Args, fix: boolean): Request {
  for (const p of a.paths ?? []) inside(root, p);
  const buffer = a.code === undefined ? undefined : { file: inside(root, a.filename ?? "snippet.ts"), text: a.code };
  if (!buffer && a.filename) throw new UsageError("`filename` needs `code`");
  return { cwd: root, paths: a.paths, buffer, fix, layer: layer({ only: a.rules, tier: a.tier, obscure: a.obscure, minImpact: a.minImpact }) };
}

const brief = (root: string) => (f: Finding) => ({
  file: path.relative(root, f.file), line: f.line, col: f.col, rule: f.rule, impact: f.impact, message: f.message,
  ...(f.fix ? { fix: { tier: f.fix.tier, ...(f.fix.assumes ? { assumes: f.fix.assumes } : {}), ...(f.fix.obscure ? { obscure: true } : {}) } } : {}),
});
const findings = (root: string, results: FileResult[]) => results.flatMap((r) => r.findings.map(brief(root)));

function call(root: string, name: string, a: Args): unknown {
  if (name === "rules") {
    if (a.rule === undefined) return allRules.map((r) => ({ name: r.name, group: r.group, impact: r.impact, tiers: r.tiers, description: r.description }));
    const r = ruleByName.get(a.rule) ?? retiredByName.get(a.rule);
    if (!r) throw new UsageError(validateNames([a.rule]).join("\n") || `unknown rule: ${a.rule}`);
    return formatExplain(r);
  }
  const fix = name === "fix";
  const res = run(request(root, a, fix));
  const errors = res.errors.length ? { errors: res.errors } : {};
  if (res.excluded) return { excluded: "the config leaves this file out", ...(fix ? { code: a.code } : { findings: [] }) };
  if (!fix) return { findings: findings(root, res.results), ...errors };

  const changed = res.results.filter((r) => r.output !== r.original);
  const applied = res.results.reduce((n, r) => n + r.fixesApplied, 0);
  const remaining = findings(root, res.results);
  if (a.code !== undefined) return { code: res.results[0]!.output, applied, remaining, ...errors };
  let diff = changed.map((r) => unifiedDiff(r.file, r.original, r.output, root)).join("");
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n[diff truncated at ${MAX_DIFF} characters; narrow \`paths\` to see the rest]\n`;
  if (a.write) for (const r of changed) fs.writeFileSync(r.file, r.output);
  return { applied, files: changed.map((r) => path.relative(root, r.file)), written: !!a.write, diff, remaining, ...errors };
}

export function handle(root: string, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...TOOL, title: "optilint" },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = String(params.name);
      if (!TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, `unknown tool: ${name}`);
      try {
        const out = call(root, name, (params.arguments ?? {}) as Args);
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

export function serve(root: string) {
  // stdout carries only protocol messages, so stray logging goes to stderr.
  console.log = console.error;
  const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let msg: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "parse error" } });
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return send({ id: null, error: { code: -32600, message: "invalid request" } });
    // Notifications (no id) and responses (no method) need no reply.
    if (msg.id === undefined || msg.id === null || typeof msg.method !== "string") return;
    try {
      send({ id: msg.id, result: handle(root, msg.method, msg.params ?? {}) });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      send({ id: msg.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  });
}
