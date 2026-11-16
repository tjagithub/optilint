/** Helpers that read regex source text without a full regex parser. */

const META = "^$.|?*+()[]{}";
const ESCAPABLE = /[\\/.^$|?*+()[\]{}-]/;

export function splitLiteral(text: string) {
  const last = text.lastIndexOf("/");
  return { source: text.slice(1, last), flags: text.slice(last + 1) };
}

/** A pattern that is plain text with optional `^`/`$` anchors, e.g. `/^foo\.bar/`. */
export function plainPattern(source: string) {
  let value = "";
  let start = false;
  let end = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      const next = source[i + 1];
      if (!next || !ESCAPABLE.test(next)) return;
      value += next;
      i++;
    } else if (c === "^" && i === 0) start = true;
    else if (c === "$" && i === source.length - 1) end = true;
    else if (META.includes(c)) return;
    else value += c;
  }
  return value ? { value, start, end } : undefined;
}

/** Turn a RegExp constructor source string into a literal body (escape `/`), or undefined if impossible. */
export function toLiteralBody(source: string) {
  if (/[\n\r\u2028\u2029]/.test(source)) return;
  if (!source) return "(?:)";
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      out += c + (source[i + 1] ?? "");
      i++;
    } else out += c === "/" ? "\\/" : c;
  }
  return out;
}

const QUANT = /^(?:[*+]|\{\d+,\d*\})/;

/** Flags `(a+)+` / `(\w+\s?)*`: a repeated group made only of optional or repeated atoms (exponential backtracking). */
export function hasNestedQuantifier(source: string) {
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") { i = skipClass(source, i); continue; }
    if (c !== "(") continue;
    const close = matchingParen(source, i);
    if (close < 0) return false;
    const after = source.slice(close + 1);
    if (QUANT.test(after) && ambiguousBody(source.slice(i + 1, close))) return true;
  }
  return false;
}

function ambiguousBody(body: string) {
  if (body.startsWith("?")) {
    if (/^\?<?[=!]/.test(body)) return false;
    body = body.replace(/^\?(?::|<[^>]+>)/, "");
  }
  let unbounded = false;
  for (let i = 0; i < body.length;) {
    const c = body[i]!;
    if (c === "(" || c === "|") return false;
    let end = i + 1;
    if (c === "\\") end = i + 2;
    else if (c === "[") end = skipClass(body, i) + 1;
    const q = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(body.slice(end));
    if (!q) return false;
    if (q[0][0] === "*" || q[0][0] === "+" || q[0].includes(",}")) unbounded = true;
    i = end + q[0].length;
  }
  return unbounded;
}

function skipClass(s: string, i: number) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "]") return j;
  }
  return s.length;
}

function matchingParen(s: string, i: number) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[") j = skipClass(s, j);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}
