import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { layer } from "../src/runner.ts";
import { startUi, type UiServer } from "../src/ui.ts";

const CODE = "const xs = [1, 2, 3];\nconst a = Array.from(xs).filter((x) => x > 1)[0];\nconst t = new Date().getTime();\n";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-ui-")));
const file = path.join(dir, "a.ts");
let ui: UiServer;
let base: URL;
let token: string;

interface View { id: number; rule: string; file: string; fix: { tier: string } | null; before?: string; after?: string }
const api = async (p: string, body?: object) => {
  const r = await fetch(new URL(p, base), { method: body ? "POST" : "GET", headers: { "x-optilint-token": token }, body: body && JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const scan = async () => (await api("/api/scan")).json as { scan: number; findings: View[]; rules: Record<string, { description?: string }> };

beforeAll(async () => {
  fs.writeFileSync(file, CODE);
  ui = await startUi({ request: { cwd: dir, layer: layer({}) }, workers: 0 });
  base = new URL(ui.url);
  token = base.searchParams.get("t")!;
});
afterAll(() => ui.close());

describe("--ui", () => {
  test("serves the page only with the token", async () => {
    expect((await fetch(ui.url)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(new URL("/", base))).status).toBe(403);
    expect((await fetch(new URL("/api/scan", base))).status).toBe(403);
  });

  test("refuses a foreign Host, as a DNS-rebinding page would send", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: base.port, path: "/api/scan", headers: { host: `evil.example:${base.port}`, "x-optilint-token": token } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    expect(status).toBe(403);
  });

  test("a scan lists findings with their rule docs and a before/after of each fix", async () => {
    const s = await scan();
    expect(s.findings.map((f) => [f.rule, f.file, f.fix?.tier])).toEqual([["filter-first", "a.ts", "typed"], ["date-now", "a.ts", "exact"]]);
    expect(s.findings[0]).toMatchObject({ before: "const a = Array.from(xs).filter((x) => x > 1)[0];", after: "const a = Array.from(xs).find((x) => x > 1);" });
    expect(s.rules["filter-first"]?.description).toContain("find");
  });

  test("applies only the picked fixes, and only from the latest scan", async () => {
    const s = await scan();
    const date = s.findings.find((f) => f.rule === "date-now")!;
    expect((await api("/api/apply", { scan: s.scan - 1, ids: [date.id] })).status).toBe(400);
    const r = await api("/api/apply", { scan: s.scan, ids: [date.id] });
    expect(r.json).toMatchObject({ applied: 1, skipped: 0, files: ["a.ts"], stale: [] });
    expect(fs.readFileSync(file, "utf8")).toBe(CODE.replace("new Date().getTime()", "Date.now()"));
    expect((await scan()).findings.map((f) => f.rule)).toEqual(["filter-first"]);
  });

  test("the CLI refuses --ui with flags that write or read stdin", () => {
    const r = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "src", "cli.ts"), "--ui", "--fix"], { cwd: dir });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--ui takes no --fix");
  });

  test("leaves a file alone that changed on disk after the scan", async () => {
    const s = await scan();
    fs.appendFileSync(file, "// edited\n");
    const before = fs.readFileSync(file, "utf8");
    const r = await api("/api/apply", { scan: s.scan, ids: s.findings.map((f) => f.id) });
    expect(r.json).toMatchObject({ applied: 0, stale: ["a.ts"] });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
