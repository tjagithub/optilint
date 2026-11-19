// Builds a CLI that runs on plain Node: <outdir>/optilint.mjs, TypeScript's lib files (looked up beside
// the running file) and skills/. Usage: bun scripts/bundle.ts [outdir]
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "dist"));

fs.rmSync(out, { recursive: true, force: true });
const built = await Bun.build({
  entrypoints: [path.join(root, "src", "cli.ts")],
  target: "node",
  format: "esm",
  minify: true,
  outdir: out,
  naming: "optilint.mjs",
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const lib = path.dirname(Bun.resolveSync("typescript", root));
// Bun inlines CommonJS __dirname/__filename as build-machine paths; TypeScript finds its libs through them.
const file = path.join(out, "optilint.mjs");
const code = fs.readFileSync(file, "utf8");
const fixed = code
  .replace(/^#!\/usr\/bin\/env bun\n/, "#!/usr/bin/env node\n")
  .replaceAll(JSON.stringify(path.join(lib, "typescript.js")), `import.meta.dirname+"/typescript.js"`)
  .replaceAll(JSON.stringify(lib), "import.meta.dirname");
if (fixed === code || fixed.includes(root)) {
  console.error(`${file}: could not replace build paths under ${root}`);
  process.exit(1);
}
fs.writeFileSync(file, fixed);
const libs = fs.readdirSync(lib).filter((f) => /^lib\..+\.d\.ts$/.test(f));
for (const f of libs) fs.copyFileSync(path.join(lib, f), path.join(out, f));
fs.cpSync(path.join(root, "skills"), path.join(out, "skills"), { recursive: true });

// The output is the npm package (`npm publish dist`); TypeScript is inlined, so it has no dependencies.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = {
  name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: "module",
  keywords: ["linter", "performance", "javascript", "typescript", "codemod"],
  bin: { optilint: "optilint.mjs" },
  // `import.meta.dirname` (20.11) finds the bundled lib files.
  engines: { node: ">=20.11" },
};
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const f of ["README.md", "LICENSE", "schema.json", "output.schema.json"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, "docs"), path.join(out, "docs"), { recursive: true });
console.log(`${path.relative(process.cwd(), out) || "."}: optilint.mjs, package.json, ${libs.length} lib files, docs/ and skills/`);
