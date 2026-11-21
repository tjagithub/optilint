// Load for server.mjs: FILE_C loops on /file and PING_C on /ping, each sending its next request when the last ends.
// Usage: load.mjs PORT MS FILE_C PING_C → prints { file: { rps, p50, p99 }, ping: { rps, p50, p99 } } (latency in ms).
import http from "node:http";

const [port, ms, fileC, pingC] = process.argv.slice(2).map(Number);
const agent = new http.Agent({ keepAlive: true, maxSockets: fileC + pingC });

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
}

async function loop(path, until, out) {
  while (performance.now() < until) {
    const t = performance.now();
    // Each loop keeps one request in flight; the loops run side by side.
    // optilint-disable-next-line await-in-loop
    await get(path);
    out.push(performance.now() - t);
  }
}

const pct = (xs, p) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? NaN;
const stats = (xs, secs) => ({ rps: Math.round(xs.length / secs), p50: +pct(xs, 0.5).toFixed(2), p99: +pct(xs, 0.99).toFixed(2) });

// Warm up both paths, then measure.
await Promise.all([get("/file"), get("/ping")]);
const file = [], ping = [];
const until = performance.now() + ms;
await Promise.all([
  ...Array.from({ length: fileC }, () => loop("/file", until, file)),
  ...Array.from({ length: pingC }, () => loop("/ping", until, ping)),
]);
agent.destroy();
console.log(JSON.stringify({ file: stats(file, ms / 1000), ping: stats(ping, ms / 1000) }));
