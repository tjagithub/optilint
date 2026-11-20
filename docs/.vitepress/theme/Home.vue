<script setup lang="ts">
import { computed, ref } from "vue";
import home from "../gen/home.json";
import speedups from "../../speedups.svg";

const tab = ref<"problems" | "diff" | "source">("problems");
const copied = ref(false);
const install = "npx @optilint/cli src";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const findings = computed(() => home.demo.output.split("\n").map((line) => {
  const m = /^(\s+)(\d+:\d+)(\s+)(high|medium|low)(\s+)([\w-]+)(\s+)(.*?)(?: \[fix: (\w+)\])?$/.exec(line);
  if (!m) return `<span class="dim">${esc(line)}</span>`;
  const [, a, pos, b, impact, c, rule, d, msg, tier] = m;
  const tag = tier ? ` <span class="tier tier-${tier}">${tier}</span>` : "";
  return `${a}<span class="dim">${pos}</span>${b}<span class="imp-${impact}">${impact}</span>${c}<a href="/reference#${rule}">${rule}</a>${d}${esc(msg!)}${tag}`;
}).join("\n"));

const diff = computed(() => home.demo.diff.split("\n").map((line) => {
  const cls = line.startsWith("+++") || line.startsWith("---") ? "dim" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
  return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
}).join("\n"));

async function copy() {
  await navigator.clipboard.writeText(install);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

const stats = [
  { n: home.stats.rules, label: "rules with stable names", link: "/reference" },
  { n: home.stats.fixable, label: "rules that --fix can rewrite", link: "/rules#fixes" },
  { n: home.stats.measured, label: "fixes benchmarked on 2 engines", link: "/rules#measured-not-guessed" },
  { n: 3, label: "fix tiers, so you know what changed", link: "/usage#fix-tiers" },
];

const tiers = [
  { name: "exact", what: "Same behaviour for every input.", ex: "new Date().getTime() → Date.now()" },
  { name: "typed", what: "Same behaviour for every input the types allow. The TypeScript checker proves the receiver is an array, a string, a Map.", ex: "xs.filter(f).length > 0 → xs.some(f)" },
  { name: "assumed", what: "Correct when the stated assumption holds, such as \"these awaits are independent\". --fix leaves them out unless you ask.", ex: "await a(); await b(); → Promise.all" },
];

const integrations = [
  { title: "GitHub Action", text: "Findings as annotations on the pull request diff, with an optional SARIF upload to code scanning.", link: "/integrations#github-actions" },
  { title: "CLI and CI", text: "Pretty, JSON, SARIF or GitHub output, a cache for unchanged files, and exit codes CI understands.", link: "/integrations#output-for-other-tools" },
  { title: "VS Code", text: "Diagnostics with quick fixes, fix-all, a sidebar grouped by tier and optilint.json completion.", link: "/integrations#vs-code" },
  { title: "Coding agents", text: "An MCP server (lint, fix, rules) and an agent skill that teaches the tiers.", link: "/integrations#coding-agents" },
  { title: "Review in the browser", text: "optilint --ui lists findings by tier and applies only the fixes you tick.", link: "/usage" },
];
</script>

<template>
  <div class="home">
    <section class="install">
      <code>$ {{ install }}</code>
      <button type="button" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
      <a href="/install">Other ways to install →</a>
    </section>

    <section class="demo">
      <div class="tabs" role="tablist">
        <button v-for="t in (['problems', 'diff', 'source'] as const)" :key="t" type="button" role="tab"
          :aria-selected="tab === t" :class="{ on: tab === t }" @click="tab = t">
          {{ t === "problems" ? "$ optilint summary.ts" : t === "diff" ? "$ optilint --diff --tier assumed" : "summary.ts" }}
        </button>
      </div>
      <pre v-if="tab === 'problems'" v-html="findings"></pre>
      <pre v-else-if="tab === 'diff'" v-html="diff"></pre>
      <pre v-else>{{ home.demo.source }}</pre>
      <p class="note">Real output of optilint {{ home.version }}, regenerated on every build.</p>
    </section>

    <section class="stats">
      <a v-for="s in stats" :key="s.label" :href="s.link"><strong>{{ s.n }}</strong><span>{{ s.label }}</span></a>
    </section>

    <section>
      <h2>Fixes that say what they guarantee</h2>
      <p class="lede">A rewrite is only worth applying if it keeps your program correct. Every fix carries a tier, and <code>--fix</code> applies the first two by default.</p>
      <div class="cards three">
        <div v-for="t in tiers" :key="t.name" class="card">
          <h3><span :class="'tier tier-' + t.name">{{ t.name }}</span></h3>
          <p>{{ t.what }}</p>
          <code>{{ t.ex }}</code>
        </div>
      </div>
    </section>

    <section>
      <h2>Measured, not guessed</h2>
      <p class="lede">Each fix is benchmarked before and after on Node (V8) and Bun (JavaScriptCore), at every compiler tier from the interpreter up. A fix that measured slower is retired, and rules over your <code>maxSlowdown</code> don't run.</p>
      <img :src="speedups" alt="How much faster each fix runs on V8 and JavaScriptCore, worst to best case" class="chart" />
      <p><a href="/rules#measured-not-guessed">How the benchmarks work →</a></p>
    </section>

    <section>
      <h2>Where you already work</h2>
      <div class="cards four">
        <a v-for="i in integrations" :key="i.title" :href="i.link" class="card">
          <h3>{{ i.title }}</h3>
          <p>{{ i.text }}</p>
        </a>
      </div>
    </section>

    <section class="closing">
      <h2>Run it on your code</h2>
      <p>No config needed: run it in the project root and it lints what git lists, with your tsconfig.</p>
      <div class="actions">
        <a class="btn brand" href="/install">Get started →</a>
        <a class="btn" href="/configuration">Configure it</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home { max-width: 1152px; margin: 0 auto; padding: 0 24px 96px; }
section { margin-top: 64px; }
h2 { font-size: 28px; font-weight: 700; line-height: 1.25; margin-bottom: 12px; }
h3 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
.home a { text-decoration: none; }
.home :deep(code) { white-space: nowrap; }
.lede { color: var(--vp-c-text-2); max-width: 720px; margin-bottom: 24px; }
.install { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.install code { font-size: 15px; padding: 10px 16px; border-radius: 8px; background: var(--vp-c-bg-soft); }
.install button { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--vp-c-divider); font-size: 14px; }
.install button:hover { border-color: var(--vp-c-brand-1); }
.install a, section p a { color: var(--vp-c-brand-1); font-weight: 500; }
.demo { border: 1px solid var(--vp-c-divider); border-radius: 12px; overflow: hidden; background: var(--vp-code-block-bg); }
.tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--vp-c-divider); }
.tabs button { padding: 10px 16px; font-family: var(--vp-font-family-mono); font-size: 13px; color: var(--vp-c-text-2); border-bottom: 2px solid transparent; }
.tabs button.on { color: var(--vp-c-text-1); border-bottom-color: var(--vp-c-brand-1); }
pre { margin: 0; padding: 20px; overflow-x: auto; font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.7; color: var(--vp-c-text-1); }
pre :deep(a) { color: var(--vp-c-brand-1); }
pre :deep(.dim) { color: var(--vp-c-text-3); }
pre :deep(.imp-high) { color: #ef4444; }
pre :deep(.imp-medium) { color: #f59e0b; }
pre :deep(.imp-low) { color: #3b82f6; }
pre :deep(.add) { color: #16a34a; }
pre :deep(.del) { color: #dc2626; }
pre :deep(.hunk) { color: #8b5cf6; }
.note { padding: 0 20px 16px; font-size: 13px; color: var(--vp-c-text-3); }
:deep(.tier) { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; font-family: var(--vp-font-family-mono); line-height: 20px; }
:deep(.tier-exact) { background: rgba(22, 163, 74, 0.16); color: #16a34a; }
:deep(.tier-typed) { background: rgba(59, 130, 246, 0.16); color: #3b82f6; }
:deep(.tier-assumed) { background: rgba(245, 158, 11, 0.18); color: #d97706; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.stats a { padding: 20px; border-radius: 12px; background: var(--vp-c-bg-soft); display: flex; flex-direction: column; gap: 4px; }
.stats a:hover { background: var(--vp-c-brand-soft); }
.stats strong { font-size: 36px; line-height: 1.1; color: var(--vp-c-brand-1); }
.stats span { color: var(--vp-c-text-2); font-size: 14px; }
.cards { display: grid; gap: 16px; }
.three { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.four { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.card { padding: 20px 24px; border-radius: 12px; border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-soft); color: inherit; }
a.card:hover { border-color: var(--vp-c-brand-1); }
.card p { color: var(--vp-c-text-2); font-size: 14px; margin-bottom: 12px; }
.card code { font-size: 13px; }
.chart { width: 100%; border-radius: 12px; background: #fff; padding: 16px; margin-bottom: 12px; }
.closing h2 { border-top: 0; padding-top: 0; margin-top: 0; }
.closing { text-align: center; padding: 48px 24px; border-radius: 16px; background: var(--vp-c-bg-soft); }
.closing p { color: var(--vp-c-text-2); margin-bottom: 20px; }
.actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.btn { padding: 10px 20px; border-radius: 20px; font-weight: 600; border: 1px solid var(--vp-c-divider); }
.btn.brand { background: var(--vp-c-brand-3); color: #fff; border-color: transparent; }
</style>
