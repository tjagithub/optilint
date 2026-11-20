import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect } from "../src/runner.ts";

/** A temp folder holding `files` (path → contents); real path, since macOS resolves /var to /private/var. */
function tree(files: Record<string, string>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "optilint-collect-")));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const git = (dir: string, ...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
const files = (dir: string, target = ".") => {
  const out: string[] = [];
  collect(target, dir, out);
  return out.map((f) => path.relative(dir, f)).sort();
};

describe("collect", () => {
  test("in a git work tree, it lints what git lists: no ignored files, no nested repositories", () => {
    const dir = tree({
      "src/a.ts": "", "src/b.js": "", "src/types.d.ts": "", "gen/c.ts": "", "nested/d.ts": "", "dist/e.js": "",
      ".gitignore": "gen/\n",
    });
    git(dir, "init", "-q");
    git(path.join(dir, "nested"), "init", "-q");
    git(dir, "add", "src/a.ts", "dist/e.js");
    expect(files(dir)).toEqual(["src/a.ts", "src/b.js"]);
    fs.rmSync(path.join(dir, "src/a.ts"));
    expect(files(dir)).toEqual(["src/b.js"]);
  });

  test("an ignored directory named outright is still linted", () => {
    const dir = tree({ "gen/c.ts": "", ".gitignore": "gen/\n" });
    git(dir, "init", "-q");
    expect(files(dir, "gen")).toEqual(["gen/c.ts"]);
  });

  test("outside git, it walks the folder, skipping build output and dot folders", () => {
    const dir = tree({ "src/a.ts": "", "node_modules/x/i.js": "", ".cache/f.js": "", "build/g.js": "" });
    expect(files(dir)).toEqual(["src/a.ts"]);
  });

  test("a path through a symlink to the working directory is rebased onto it", () => {
    const dir = tree({ "src/a.ts": "" });
    const link = path.join(fs.realpathSync(os.tmpdir()), `optilint-link-${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(dir, link);
    try {
      const out: string[] = [];
      collect(path.join(link, "src/a.ts"), dir, out);
      expect(out).toEqual([path.join(dir, "src/a.ts")]);
    } finally {
      fs.rmSync(link);
    }
  });
});
