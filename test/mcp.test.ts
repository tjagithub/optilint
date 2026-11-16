import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-mcp-")));
fs.writeFileSync(path.join(root, "a.ts"), "const xs: number[] = [1];\nexport const y = xs.filter((x) => x > 0).length > 0;\n");
fs.mkdirSync(path.join(root, "lib"));
fs.writeFileSync(path.join(root, "lib", "b.ts"), "export const list: number[] = [];\n");
fs.writeFileSync(path.join(root, "uses.ts"), `import { list } from "./lib/b";\nexport const z = list.filter((x) => x).length > 0;\n`);

const proc = Bun.spawn(["bun", CLI, "--mcp"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const waiting = new Map<number, (m: Message) => void>();
interface Message {
  id: number | null;
  result?: { content?: { text: string }[]; isError?: boolean } & Record<string, unknown>;
  error?: { code: number; message: string };
}
const received: Message[] = [];
(async () => {
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += new TextDecoder().decode(chunk);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Message;
      buf = buf.slice(i + 1);
      received.push(m);
      if (typeof m.id === "number") waiting.get(m.id)?.(m);
    }
  }
})();

let next = 1;
function send(raw: object | string): void {
  proc.stdin.write(`${typeof raw === "string" ? raw : JSON.stringify({ jsonrpc: "2.0", ...raw })}\n`);
  proc.stdin.flush();
}
function rpc(method: string, params?: object): Promise<Message> {
  const id = next++;
  const reply = new Promise<Message>((resolve) => waiting.set(id, resolve));
  send({ id, method, params });
  return reply;
}
async function tool(name: string, args: object) {
  const m = await rpc("tools/call", { name, arguments: args });
  const text = m.result!.content![0]!.text;
  return { isError: !!m.result!.isError, text, json: () => JSON.parse(text) };
}

afterAll(() => {
  proc.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("protocol", () => {
  test("initialize negotiates the version and describes the tiers", async () => {
    const r = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })).result!;
    expect(r.protocolVersion).toBe("2025-06-18");
    expect((r.serverInfo as { name: string }).name).toBe("optilint");
    expect(String(r.instructions)).toContain("assumed");
    const newer = (await rpc("initialize", { protocolVersion: "2099-01-01" })).result!;
    expect(newer.protocolVersion).toBe("2025-11-25");
  });

  test("notifications get no reply; unknown methods and bad JSON get errors", async () => {
    const before = received.length;
    send({ method: "notifications/initialized" });
    expect((await rpc("ping")).result).toEqual({});
    expect(received.length).toBe(before + 1);
    expect((await rpc("resources/list")).error?.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope" })).error?.code).toBe(-32602);
    send("{not json");
    await rpc("ping");
    expect(received.some((m) => m.id === null && m.error?.code === -32700)).toBe(true);
  });

  test("lists three tools with input schemas", async () => {
    const { tools } = (await rpc("tools/list")).result as unknown as { tools: { name: string; inputSchema: { type: string } }[] };
    expect(tools.map((t) => t.name)).toEqual(["lint", "fix", "rules"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });
});

describe("tools", () => {
  test("lint a snippet", async () => {
    const { findings } = (await tool("lint", { code: "export const f = (xs: number[]) => xs.filter(Boolean).length > 0;" })).json();
    expect(findings).toEqual([expect.objectContaining({ file: "snippet.ts", rule: "filter-length-to-some", fix: { tier: "typed" } })]);
  });

  test("lint files, with paths relative to the root", async () => {
    const { findings } = (await tool("lint", { paths: ["a.ts"] })).json();
    expect(findings.map((f: { file: string; rule: string }) => `${f.file}:${f.rule}`)).toEqual(["a.ts:filter-length-to-some"]);
  });

  test("fix a snippet returns the text", async () => {
    const out = (await tool("fix", { code: "export const f = (xs: number[]) => xs.filter(Boolean).length > 0;" })).json();
    expect(out.code).toBe("export const f = (xs: number[]) => xs.some(Boolean);");
    expect(out.applied).toBe(1);
  });

  test("fix files previews a diff, and writes only when asked", async () => {
    const preview = (await tool("fix", { paths: ["a.ts"] })).json();
    expect(preview.written).toBe(false);
    expect(preview.diff).toContain("+export const y = xs.some((x) => x > 0);");
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain(".filter(");
    const done = (await tool("fix", { paths: ["a.ts"], write: true })).json();
    expect(done.files).toEqual(["a.ts"]);
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain(".some(");
  });

  test("sees an imported file change between calls", async () => {
    const tier = async () => (await tool("lint", { paths: ["uses.ts"] })).json().findings[0]?.fix?.tier;
    expect(await tier()).toBe("typed");
    fs.writeFileSync(path.join(root, "lib", "b.ts"), "export const list: any = [];\n");
    fs.utimesSync(path.join(root, "lib", "b.ts"), new Date(), new Date(Date.now() + 5000));
    expect(await tier()).toBe("assumed");
  });

  test("rules explains one rule or lists them all", async () => {
    expect((await tool("rules", { rule: "filter-first" })).text).toContain("filter-first");
    const all = (await tool("rules", {})).json();
    expect(all.length).toBeGreaterThan(20);
    const bad = await tool("rules", { rule: "filter-frist" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('did you mean "filter-first"');
  });

  test("refuses paths outside the root and bad settings", async () => {
    const out = await tool("lint", { paths: ["../"] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("outside");
    expect((await tool("fix", { code: "x", filename: "/etc/x.ts" })).isError).toBe(true);
    expect((await tool("fix", { paths: ["a.ts"], tier: "typd" })).text).toContain("invalid --tier");
    expect((await tool("lint", { paths: ["missing.ts"] })).text).toContain("no such file");
  });
});
