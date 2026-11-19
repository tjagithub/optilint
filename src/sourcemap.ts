import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A position in an original source: absolute path, 0-based line and column. */
export interface Original { file: string; line: number; col: number }

const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((ch, i) => [ch, i]));

/** Base64 VLQ numbers of one mapping segment. */
function vlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0, shift = 0;
  for (const ch of segment) {
    const digit = B64.get(ch);
    if (digit === undefined) throw new Error(`bad mapping character ${JSON.stringify(ch)}`);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = shift = 0;
    }
  }
  return out;
}

/** Source map v3 lookups: generated (line, column) → original position. */
export class SourceMap {
  /** Per generated line: [generated column, source index, original line, original column], by column. */
  private readonly lines: [number, number, number, number][][] = [];
  private readonly sources: string[];

  constructor(json: { sources: string[]; sourceRoot?: string; mappings: string }, dir: string) {
    this.sources = json.sources.map((s) => path.resolve(dir, json.sourceRoot ?? "", s.startsWith("file://") ? fileURLToPath(s) : s));
    let src = 0, line = 0, col = 0;
    for (const text of json.mappings.split(";")) {
      const segs: [number, number, number, number][] = [];
      let gen = 0;
      for (const s of text.split(",")) {
        if (!s) continue;
        const v = vlq(s);
        gen += v[0]!;
        // A one-field segment maps to nothing; it ends the previous mapping.
        if (v.length < 4) continue;
        src += v[1]!; line += v[2]!; col += v[3]!;
        segs.push([gen, src, line, col]);
      }
      this.lines.push(segs);
    }
  }

  /** The mapping in effect at a generated position: the last segment at or before it on its line. */
  original(line: number, col: number): Original | undefined {
    const segs = this.lines[line];
    let hit: [number, number, number, number] | undefined;
    for (const s of segs ?? []) if (s[0] <= col) hit = s;
    else break;
    return hit && { file: this.sources[hit[1]]!, line: hit[2], col: hit[3] };
  }
}

const URL_COMMENT = /[#@] sourceMappingURL=(\S+)\s*$/;

/** The source map a generated file names in its last `sourceMappingURL` comment, if it has one. */
export function loadSourceMap(file: string): SourceMap | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const url = URL_COMMENT.exec(text.slice(-4096))?.[1];
  if (!url) return undefined;
  const inline = /^data:application\/json[^,]*;base64,(.*)$/.exec(url);
  try {
    const raw = inline ? Buffer.from(inline[1]!, "base64").toString("utf8") : fs.readFileSync(path.resolve(path.dirname(file), url), "utf8");
    return new SourceMap(JSON.parse(raw), path.dirname(inline ? file : path.resolve(path.dirname(file), url)));
  } catch {
    return undefined;
  }
}
