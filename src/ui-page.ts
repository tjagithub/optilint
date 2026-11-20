// The page `optilint --ui` serves: plain DOM code, no build step. Its script avoids backticks so it fits in this string.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>optilint</title>
<link rel="icon" href="data:,">
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --panel: #fff; --line: #dde1e6; --text: #1d2125; --dim: #66707a; --accent: #1f8f4e; --warn: #b26a00; --bad: #c0392b; --del: #fdecea; --add: #e8f6ec; }
@media (prefers-color-scheme: dark) { :root { --bg: #16191c; --panel: #1f2327; --line: #343a40; --text: #e4e7ea; --dim: #9aa3ab; --del: #3a1f1f; --add: #1c3326; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); display: grid; grid-template: "head head" auto "side main" 1fr "side foot" auto / 240px 1fr; height: 100vh; }
header { grid-area: head; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
header h1 { font-size: 18px; margin: 0; } header .root { color: var(--dim); font-family: ui-monospace, monospace; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav { grid-area: side; background: var(--panel); border-right: 1px solid var(--line); padding: 12px; overflow: auto; }
nav a { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; color: inherit; text-decoration: none; } nav a:hover { background: var(--bg); }
nav .n { margin-left: auto; color: var(--dim); font-variant-numeric: tabular-nums; }
main { grid-area: main; overflow: auto; padding: 16px 20px; }
footer { grid-area: foot; display: flex; align-items: center; gap: 12px; padding: 10px 20px; background: var(--panel); border-top: 1px solid var(--line); }
button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: inherit; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
button.go { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; padding: 8px 20px; } button:disabled { opacity: .5; cursor: default; }
section { margin-bottom: 24px; } h2 { font-size: 15px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; } .blurb { color: var(--dim); margin: 0 0 8px; }
.rule { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; }
.rule > .row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer; }
.rule .name { font-family: ui-monospace, monospace; font-weight: 600; } .rule .speed { color: var(--dim); font-size: 12px; margin-left: auto; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--line); color: var(--dim); }
.badge.high { color: var(--bad); border-color: var(--bad); } .badge.medium { color: var(--warn); border-color: var(--warn); }
.body { border-top: 1px solid var(--line); padding: 8px 10px 4px 36px; } .about { color: var(--dim); margin: 0 0 8px; }
.finding { padding: 6px 0; border-top: 1px dashed var(--line); } .finding:first-of-type { border-top: 0; }
.finding .head { display: flex; gap: 8px; align-items: baseline; } .loc { font-family: ui-monospace, monospace; font-size: 12px; color: var(--dim); }
.assumes { margin: 4px 0 0 24px; padding: 4px 8px; border-left: 3px solid var(--warn); font-size: 13px; }
.diff { margin: 4px 0 0 24px; } pre { margin: 0; padding: 4px 8px; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.del { background: var(--del); } pre.add { background: var(--add); }
#status { color: var(--dim); flex: 1; } #status.err { color: var(--bad); }
.empty { text-align: center; color: var(--dim); margin-top: 20vh; font-size: 16px; }
</style>
</head>
<body>
<header><h1>optilint</h1><span class="root" id="root"></span><button id="scan">Scan</button></header>
<nav id="side"></nav>
<main id="main"><p class="empty">Scanning…</p></main>
<footer><span id="status"></span><button class="go" id="fix" disabled>Fix selected</button></footer>
<script>
const token = new URLSearchParams(location.search).get("t");
const $ = (id) => document.getElementById(id);
const CATS = [
  ["exact", "Exact", "Same behaviour for every input."],
  ["typed", "Typed", "Same behaviour for every input the types allow."],
  ["assumed", "Assumed", "Correct only if the stated assumption holds: check each one first."],
  ["report", "Advice", "No automatic fix. Change this code only where it is hot or measured."],
];
let data = null;
const picked = new Set(), opened = new Set();
const cat = (f) => (f.fix ? f.fix.tier : "report");

async function api(url, body) {
  const r = await fetch(url, { method: body ? "POST" : "GET", headers: { "x-optilint-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "class") e.className = v; else e[k] = v;
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
function status(text, err) { $("status").textContent = text; $("status").className = err ? "err" : ""; }
function box(ids) {
  const on = ids.filter((id) => picked.has(id)).length;
  const b = h("input", { type: "checkbox", checked: on > 0 && on === ids.length, onclick: (e) => e.stopPropagation(), onchange: (e) => {
    for (const id of ids) e.target.checked ? picked.add(id) : picked.delete(id);
    render();
  } });
  b.indeterminate = on > 0 && on < ids.length;
  return b;
}
const fixable = (list) => list.filter((f) => f.fix).map((f) => f.id);
function speed(s) {
  if (!s) return "";
  const r = (e) => e.worst.toFixed(2) + "–" + e.best.toFixed(2) + "×";
  return "measured V8 " + r(s.v8) + ", JSC " + r(s.jsc);
}
function n(count, one, many) { return count + " " + (count === 1 ? one : many || one + "s"); }

function finding(f) {
  return h("div", { class: "finding" },
    h("div", { class: "head" }, f.fix ? box([f.id]) : null, h("span", { class: "loc" }, f.file + ":" + f.line + ":" + f.col), h("span", {}, f.message),
      f.fix && f.fix.obscure ? h("span", { class: "badge", title: "Correct, but harder to read" }, "obscure") : null),
    f.fix && f.fix.assumes ? h("div", { class: "assumes" }, "Assumes " + f.fix.assumes) : null,
    f.before !== undefined ? h("div", { class: "diff" }, h("pre", { class: "del" }, f.before), h("pre", { class: "add" }, f.after)) : null);
}
function rule(key, name, list) {
  const info = data.rules[name] || {}, id = key + ":" + name, open = opened.has(id);
  return h("div", { class: "rule" },
    h("div", { class: "row", onclick: () => { open ? opened.delete(id) : opened.add(id); render(); } },
      key === "report" ? null : box(fixable(list)), h("span", {}, open ? "▾" : "▸"), h("span", { class: "name" }, name),
      h("span", { class: "badge " + info.impact }, info.impact), h("span", { class: "loc" }, list.length + (list.length === 1 ? " finding" : " findings")),
      h("span", { class: "speed", title: "Before ÷ after time in microbenchmarks of this pattern, not of your app" }, speed(info.speedup))),
    open ? h("div", { class: "body" }, h("p", { class: "about" }, (info.description || "") + " " + (info.why || "")), list.map(finding)) : null);
}
function render() {
  const groups = CATS.map(([key, title, blurb]) => {
    const list = data.findings.filter((f) => cat(f) === key);
    const byRule = new Map();
    for (const f of list) byRule.set(f.rule, [...(byRule.get(f.rule) || []), f]);
    return { key, title, blurb, list, byRule };
  }).filter((g) => g.list.length);
  $("side").replaceChildren(...groups.map((g) => h("a", { href: "#" + g.key }, g.key === "report" ? null : box(fixable(g.list)), g.title, h("span", { class: "n" }, String(g.list.length)))));
  $("main").replaceChildren(...(groups.length ? groups.map((g) => h("section", { id: g.key },
    h("h2", {}, g.title), h("p", { class: "blurb" }, g.blurb), [...g.byRule].map(([name, list]) => rule(g.key, name, list))))
    : [h("p", { class: "empty" }, "Nothing to optimize.")]));
  $("fix").textContent = "Fix selected (" + picked.size + ")";
  $("fix").disabled = !picked.size;
}
async function scan() {
  $("scan").disabled = $("fix").disabled = true;
  status("Scanning…");
  try {
    data = await api("/api/scan");
    $("root").textContent = data.root;
    picked.clear();
    for (const f of data.findings) if (f.fix && f.fix.tier !== "assumed" && !f.fix.obscure) picked.add(f.id);
    render();
    const files = new Set(data.findings.map((f) => f.file)).size;
    status(n(data.findings.length, "finding") + " in " + n(files, "file") + (data.errors.length ? "; " + n(data.errors.length, "rule error") + " (see the terminal)" : ""));
    for (const e of data.errors) console.error(e);
  } catch (e) {
    status(e.message, true);
  } finally {
    $("scan").disabled = false;
  }
}
async function fix() {
  const assumed = data.findings.filter((f) => picked.has(f.id) && f.fix.tier === "assumed").length;
  if (assumed && !confirm(assumed + " of the selected fixes are assumed. Have you checked that their assumptions hold?")) return;
  $("fix").disabled = true;
  try {
    const r = await api("/api/apply", { scan: data.scan, ids: [...picked] });
    await scan();
    const parts = ["Applied " + n(r.applied, "fix", "fixes") + " in " + n(r.files.length, "file") + "."];
    if (r.skipped) parts.push(r.skipped + " overlapped another fix; apply again to get them.");
    if (r.stale.length) parts.push("Changed on disk since the scan, so left alone: " + r.stale.join(", ") + ".");
    status(parts.join(" "), r.stale.length > 0);
  } catch (e) {
    status(e.message, true);
    $("fix").disabled = false;
  }
}
$("scan").onclick = scan;
$("fix").onclick = fix;
scan();
</script>
</body>
</html>
`;
