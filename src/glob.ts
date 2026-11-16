// Config globs on plain Node too (Bun.Glob is Bun-only): `**`, `*`, `?`, `{a,b}` and `[...]`, on "/" paths.
const cache = new Map<string, RegExp>();
const escape = (c: string) => (/[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c);

export function globRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) return re;
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      const atSegmentStart = i === 0 || glob[i - 1] === "/";
      if (atSegmentStart && slashAfter) {
        out += "(?:[^/]*/)*";
        i += 2;
      } else if (atSegmentStart && i + 2 === glob.length) {
        out = out.endsWith("/") ? `${out.slice(0, -1)}(?:/.*)?` : `${out}.*`;
        i += 1;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces) {
      braces--;
      out += ")";
    } else if (c === "," && braces) out += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else out += escape(c === "\\" && i + 1 < glob.length ? glob[++i]! : c);
  }
  re = new RegExp(`^${out}$`);
  cache.set(glob, re);
  return re;
}

export const globMatch = (glob: string, path: string) => globRegExp(glob).test(path);
