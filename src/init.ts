import fs from "node:fs";
import path from "node:path";
import { CONFIG_NAMES, findConfig } from "./config.ts";
import { UsageError } from "./runner.ts";

/** The website serves `optilint --print-schema config` here, so editors complete optilint.json without an install. */
export const SCHEMA_URL = "https://optilint.pages.dev/schema.json";

function packageKey(dir: string) {
  try {
    return "optilint" in JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return false;
  }
}

/** Writes a starter optilint.json in `dir` and returns its path. A parent's optilint.json(c) is extended, not shadowed. */
export function init(dir: string): string {
  const existing = CONFIG_NAMES.find((n) => fs.existsSync(path.join(dir, n))) ?? (packageKey(dir) ? "package.json" : undefined);
  if (existing) throw new UsageError(`${existing} already configures optilint in this folder`);
  const parent = findConfig(path.dirname(dir));
  const base = parent && CONFIG_NAMES.includes(path.basename(parent)) ? [path.relative(dir, parent).split(path.sep).join("/")] : undefined;
  const config = { $schema: SCHEMA_URL, ...(base && { extends: base }), tier: "typed", rules: { preset: "recommended" } };
  const file = path.join(dir, "optilint.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  return file;
}
