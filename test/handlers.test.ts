import { describe, expect, test } from "bun:test";
import { rulesHit, run } from "./helpers.ts";

// Stand-ins for @types/node, express and Bun's global, declared the way they are.
const extra = {
  "/virtual/decls.d.ts": `declare module "fs" { export function readFileSync(p: string): string; export function existsSync(p: string): boolean; }
declare module "node:fs" { export * from "fs"; }
declare module "http" { export class IncomingMessage { url?: string } export class ServerResponse { end(s: string): void }
  export function createServer(h: (req: unknown, res: { end(s: string): void }) => void): { listen(p: number): void }; }
declare module "express" { interface App { get(path: string, ...h: ((req: unknown, res: { send(s: string): void }) => void)[]): void } export default function express(): App; }
declare const Bun: { serve(o: { fetch(req: unknown): unknown }): void };`,
};
const hit = (code: string) => rulesHit(code, { rule: "sync-io-in-handler", extra });

describe("sync-io-in-handler", () => {
  test("a sync read in an http handler", () => {
    expect(hit(`import * as fs from "fs";\nimport { createServer } from "http";\ncreateServer((req, res) => res.end(fs.readFileSync("a")));`))
      .toEqual(["sync-io-in-handler"]);
  });

  test("an express route, in a callback inside it, imported through node:fs", () => {
    const code = `import { readFileSync } from "node:fs";\nimport express from "express";\nconst app = express();
app.get("/", (req, res) => res.send(["a", "b"].map((p) => readFileSync(p)).join()));`;
    expect(hit(code)).toEqual(["sync-io-in-handler"]);
  });

  test("any function taking node:http's request or response: custom routers and helpers", () => {
    const code = `import { readFileSync } from "fs";\nimport type { IncomingMessage, ServerResponse } from "http";
declare function route(path: string, h: (req: IncomingMessage, res: ServerResponse) => void): void;
route("/", (req, res) => res.end(readFileSync("a")));
function serveFile(req: IncomingMessage, res: ServerResponse, file: string) { res.end(readFileSync(file)); }`;
    expect(hit(code)).toEqual(["sync-io-in-handler", "sync-io-in-handler"]);
  });

  test("Bun.serve's fetch; existsSync points to access", () => {
    const r = run(`import { existsSync } from "fs";\nBun.serve({ fetch(req) { return existsSync("x"); } });`, { rule: "sync-io-in-handler", extra }).findings;
    expect(r.map((f) => f.rule)).toEqual(["sync-io-in-handler"]);
    expect(r[0]!.message).toContain("fs.promises.access");
  });

  test("startup code, other get methods and other Sync functions are left alone", () => {
    expect(hit(`import { readFileSync } from "fs";\nimport { createServer } from "http";\nconst page = readFileSync("index.html");\ncreateServer((req, res) => res.end(page));`)).toEqual([]);
    expect(hit(`import { readFileSync } from "fs";\nconst router = { get(p: string, h: () => void) {} };\nrouter.get("/", () => readFileSync("a"));`)).toEqual([]);
    expect(hit(`import { createServer } from "http";\nfunction loadSync() { return "x"; }\ncreateServer((req, res) => res.end(loadSync()));`)).toEqual([]);
  });
});
