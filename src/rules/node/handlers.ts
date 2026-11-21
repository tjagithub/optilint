// Request handlers: code that runs once per request, where a blocking call stalls every other request in flight.
import ts from "typescript";
import { staticCall } from "../../core/ast.ts";
import { declarationsOf, declaredIn } from "../../core/modules.ts";
import type { RuleContext, RuleDef } from "../../core/types.ts";

const K = ts.SyntaxKind;
const BLOCKING = ["fs", "child_process", "zlib", "crypto"];
const SERVERS = ["http", "https", "http2"];
const FRAMEWORKS = ["express", "express-serve-static-core", "hono", "fastify", "koa", "@koa/router", "koa-router"];
const ROUTES = new Set(["get", "post", "put", "patch", "delete", "del", "head", "options", "all", "use", "on", "route"]);
const OPTION_HANDLERS = new Set(["fetch", "handler"]);
// Async forms whose name is not the Sync name minus "Sync".
const ASYNC_FORM: Record<string, string> = { existsSync: "`fs.promises.access` (it rejects when the path is missing)" };
const REQUEST_TYPES = new Set(["IncomingMessage", "ServerResponse", "Http2ServerRequest", "Http2ServerResponse"]);

/** node:http's request or response, or a type built on it (express's Request extends IncomingMessage). */
function isRequestType(type: ts.Type, ctx: RuleContext, depth = 0): boolean {
  const s = type.getSymbol();
  if (s && REQUEST_TYPES.has(s.name) && s.declarations?.some((d) => declaredIn(d, SERVERS))) return true;
  if (depth > 4 || !(type.flags & ts.TypeFlags.Object)) return false;
  const flags = (type as ts.ObjectType).objectFlags;
  const target = flags & ts.ObjectFlags.Reference ? (type as ts.TypeReference).target : type;
  if (!((target as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) return false;
  return (ctx.checker.getBaseTypes(target as ts.InterfaceType) ?? []).some((b) => isRequestType(b, ctx, depth + 1));
}

/** The call `fn` is given to: as an argument, or as `fetch` / `handler` of an options object argument. */
function registeredBy(fn: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(fn.parent) && fn.parent.arguments.some((a) => a === fn)) return fn.parent;
  const prop = ts.isMethodDeclaration(fn) ? fn : ts.isPropertyAssignment(fn.parent) ? fn.parent : undefined;
  const obj = prop?.parent;
  if (!prop || !obj || !ts.isObjectLiteralExpression(obj) || !ts.isCallExpression(obj.parent)) return undefined;
  return ts.isIdentifier(prop.name) && OPTION_HANDLERS.has(prop.name.text) ? obj.parent : undefined;
}

/** Runs per request: takes node:http's request or response (whatever registers it), or is registered with `createServer`,
 * a framework's route method, `Bun.serve` or `Deno.serve`. */
function isHandler(fn: ts.SignatureDeclaration, ctx: RuleContext) {
  if (fn.parameters.some((p) => isRequestType(ctx.checker.getTypeAtLocation(p), ctx))) return true;
  const call = registeredBy(fn);
  if (!call) return false;
  if (staticCall(call, "Bun", "serve") || staticCall(call, "Deno", "serve")) return true;
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
  if (name !== "createServer" && !ROUTES.has(name)) return false;
  const from = name === "createServer" ? SERVERS : FRAMEWORKS;
  return declarationsOf(callee, ctx.checker).some((d) => declaredIn(d, from));
}

export const syncIoInHandler: RuleDef = {
  name: "sync-io-in-handler",
  impact: "high",
  tiers: [],
  description: "`readFileSync` and other `*Sync` calls of fs, child_process, zlib or crypto inside a request handler",
  why: "A sync call blocks the event loop, so every other request waits until it returns. Measured on Node and Bun with 16 concurrent reads of a 16 MB file, other requests took 16–33 ms instead of 0.1–0.2 ms; with 1 KB files, sync reads still halved their throughput, and the reads themselves were slower than `await readFile`. Startup code and CLIs are not handlers, so they are left alone.",
  kinds: [K.CallExpression],
  check(node, ctx) {
    const callee = (node as ts.CallExpression).expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
    if (!name?.endsWith("Sync") || !declarationsOf(callee, ctx.checker).some((d) => declaredIn(d, BLOCKING))) return;
    if (!ts.findAncestor(node.parent, (a) => ts.isFunctionLike(a) && isHandler(a, ctx))) return;
    ctx.report(node, `\`${name}\` blocks the event loop inside a request handler, so every other request waits for it; await ${ASYNC_FORM[name] ?? `the async \`${name.slice(0, -4)}\``} instead.`);
  },
};
