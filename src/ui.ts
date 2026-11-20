// `optilint --ui`: a page on 127.0.0.1 to review findings by tier and apply the fixes you pick.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { applyFixes, type FileResult } from "./core/engine.ts";
import type { Finding } from "./core/types.ts";
import { TOOL } from "./report.ts";
import { ruleByName } from "./rules/index.ts";
import { type Request, runParallel, UsageError } from "./runner.ts";
import { SPEEDUPS } from "./speedups.ts";
import { PAGE } from "./ui-page.ts";

export interface UiOptions {
  request: Omit<Request, "fix">;
  workers: number;
  /** Default 0: any free port. */
  port?: number;
  /** Open the page in the default browser. */
  open?: boolean;
}

export interface UiServer {
  url: string;
  close(): Promise<void>;
}

interface Scan {
  id: number;
  results: FileResult[];
  findings: Finding[];
}

const MAX_PREVIEW = 4000;
const MAX_BODY = 1 << 20;

/** The lines a fix touches, before and after it. */
function preview(text: string, f: Finding) {
  const edits = f.fix?.edits;
  if (!edits?.length) return {};
  let lo = Infinity, hi = 0;
  for (const e of edits) {
    lo = Math.min(lo, e.start);
    hi = Math.max(hi, e.end);
  }
  const from = text.lastIndexOf("\n", lo - 1) + 1;
  const end = text.indexOf("\n", hi);
  const to = end < 0 ? text.length : end;
  let after = text.slice(from, to);
  for (const e of [...edits].sort((a, b) => b.start - a.start)) after = after.slice(0, e.start - from) + e.text + after.slice(e.end - from);
  const before = text.slice(from, to);
  const cut = (s: string) => (s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW)}\n…` : s);
  return { before: cut(before), after: cut(after) };
}

function payload(scan: Scan, root: string, errors: string[]) {
  const text = new Map(scan.results.map((r) => [r.file, r.original]));
  const findings = scan.findings.map((f, id) => ({
    id, file: path.relative(root, f.file), line: f.line, col: f.col, rule: f.rule, impact: f.impact, message: f.message,
    fix: f.fix ? { tier: f.fix.tier, assumes: f.fix.assumes, obscure: !!f.fix.obscure } : null,
    ...preview(text.get(f.file)!, f),
  }));
  const rules = Object.fromEntries([...new Set(scan.findings.map((f) => f.rule))].map((name) => {
    const r = ruleByName.get(name);
    return [name, { group: r?.group, impact: r?.impact, description: r?.description, why: r?.why, speedup: SPEEDUPS[name] }];
  }));
  return { scan: scan.id, root, tool: TOOL, findings, rules, errors };
}

/** Writes the picked fixes of one scan; a file that changed on disk since is left alone. */
function apply(scan: Scan, ids: number[]) {
  const byFile = new Map<string, Finding[]>();
  for (const id of new Set(ids)) {
    const f = scan.findings[id];
    if (!f?.fix) throw new UsageError(`no fix with id ${id} in this scan`);
    byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  }
  let applied = 0, skipped = 0;
  const files: string[] = [], stale: string[] = [];
  const originals = new Map(scan.results.map((r) => [r.file, r.original]));
  for (const [file, picked] of byFile) {
    const original = originals.get(file)!;
    if (fs.readFileSync(file, "utf8") !== original) {
      stale.push(file);
      continue;
    }
    const out = applyFixes(original, picked.sort((a, b) => a.start - b.start));
    applied += out.applied;
    skipped += picked.length - out.applied;
    if (out.text !== original) {
      fs.writeFileSync(file, out.text);
      files.push(file);
    }
  }
  return { applied, skipped, files, stale };
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d;
      if (body.length > MAX_BODY) reject(new UsageError("request too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new UsageError("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export async function startUi(opts: UiOptions): Promise<UiServer> {
  const root = opts.request.cwd;
  const token = crypto.randomBytes(16).toString("hex");
  let scan: Scan | undefined;
  let scans = 0;
  let port = 0;

  const handle = async (req: http.IncomingMessage, url: URL): Promise<{ html: string } | { json: unknown } | undefined> => {
    if (req.method === "GET" && url.pathname === "/") return { html: PAGE };
    if (req.method === "GET" && url.pathname === "/api/scan") {
      const run = await runParallel({ ...opts.request, fix: false }, opts.workers);
      scan = { id: ++scans, results: run.results, findings: run.results.flatMap((r) => r.findings) };
      return { json: payload(scan, root, run.errors) };
    }
    if (req.method === "POST" && url.pathname === "/api/apply") {
      const body = (await readBody(req)) as { scan?: number; ids?: unknown };
      if (!scan || body.scan !== scan.id) throw new UsageError("this scan is out of date; scan again");
      if (!Array.isArray(body.ids) || !body.ids.every(Number.isInteger)) throw new UsageError("ids must be integers");
      const out = apply(scan, body.ids as number[]);
      return { json: { ...out, files: out.files.map((f) => path.relative(root, f)), stale: out.stale.map((f) => path.relative(root, f)) } };
    }
    return undefined;
  };

  const server = http.createServer((req, res) => {
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    // Another site could reach this port from the browser: a foreign Host (DNS rebinding) or a missing token stops it.
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    const given = url.pathname === "/" ? url.searchParams.get("t") : req.headers["x-optilint-token"];
    if (!hostOk || given !== token) return send(403, JSON.stringify({ error: "forbidden" }));
    handle(req, url).then((out) => {
      if (!out) send(404, JSON.stringify({ error: "not found" }));
      else if ("html" in out) send(200, out.html, "text/html");
      else send(200, JSON.stringify(out.json));
    }, (e: unknown) => send(e instanceof UsageError ? 400 : 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) })));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  if (opts.open) openBrowser(url);
  return { url, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
