// An HTTP server whose /file handler reads a file with readFileSync or await readFile; /ping answers at once.
// Runs on node and bun. Usage: server.mjs sync|async FILE → prints the port once listening.
import fs from "node:fs";
import http from "node:http";

const [mode, file] = process.argv.slice(2);
const read = mode === "sync" ? async () => fs.readFileSync(file) : () => fs.promises.readFile(file);

const server = http.createServer(async (req, res) => {
  if (req.url === "/file") {
    const data = await read();
    res.end(String(data.length));
  } else res.end("ok");
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
