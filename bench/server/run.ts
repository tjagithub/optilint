// Sync vs async file reads in a request handler, on node and bun (`bun bench/server/run.ts [--ms N]`).
// The file sits in the page cache, the best case for readFileSync; /ping shows how long other requests wait.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const ms = Number(args[args.indexOf("--ms") + 1] || 3000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optilint-server-"));
const server = path.join(import.meta.dirname, "server.mjs");
const load = path.join(import.meta.dirname, "load.mjs");
const SIZES = { "1 KB": 1 << 10, "1 MB": 1 << 20, "16 MB": 16 << 20 };

async function measure(runtime: string, mode: string, file: string) {
  const child = spawn(runtime, [server, mode, file], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
  const r = spawnSync("node", [load, port, String(ms), "16", "4"], { encoding: "utf8" });
  child.kill();
  if (r.status !== 0) throw new Error(`${runtime} ${mode}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<"file" | "ping", { rps: number; p50: number; p99: number }>;
}

console.log("runtime size   mode  | /file req/s  p50 ms   p99 ms | /ping req/s  p50 ms   p99 ms");
for (const [label, bytes] of Object.entries(SIZES)) {
  const file = path.join(dir, `${bytes}.bin`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  for (const runtime of ["node", "bun"]) {
    for (const mode of ["sync", "async"]) {
      // One server at a time: the runs must not overlap.
      // optilint-disable-next-line await-in-loop
      const r = await measure(runtime, mode, file);
      const cols = (s: { rps: number; p50: number; p99: number }) => `${String(s.rps).padStart(11)} ${String(s.p50).padStart(7)} ${String(s.p99).padStart(8)}`;
      console.log(`${runtime.padEnd(7)} ${label.padEnd(6)} ${mode.padEnd(5)} |${cols(r.file)} |${cols(r.ping)}`);
    }
  }
}
fs.rmSync(dir, { recursive: true, force: true });
