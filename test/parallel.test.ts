import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, runParallel } from "../src/runner.ts";
import { twoProjects } from "./projects.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-parallel-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("worker threads give the same findings as an inline run", async () => {
  twoProjects(root);
  const req = { cwd: root, paths: ["."], fix: false, layer: {} };
  const inline = run(req).results.flatMap((r) => r.findings);
  const parallel = (await runParallel(req, 2)).results.flatMap((r) => r.findings);
  expect(inline.length).toBe(240);
  expect(parallel).toEqual(inline);
});
