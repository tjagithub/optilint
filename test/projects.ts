import fs from "node:fs";
import path from "node:path";

/** Two tsconfig projects of `per` files each (4 findings per file), enough for the runner to use workers. */
export function twoProjects(root: string, per = 60) {
  for (const pkg of ["a", "b"]) {
    const dir = path.join(root, pkg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    for (let i = 0; i < per; i++) {
      const body = `export const xs${i}: number[] = [];\nxs${i}.forEach((x) => console.log(x));\nexport const n${i} = xs${i}.filter((x) => x > ${i}).length > 0;\n`;
      fs.writeFileSync(path.join(dir, `f${i}.ts`), body);
    }
  }
}
