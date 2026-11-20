import { defineConfig } from "vitepress";

const site = "https://optilint.pages.dev";
const description = "optilint finds slow JavaScript and TypeScript and rewrites it: O(n²) accumulators, lookups in loops, needless allocations, sequential awaits. Type-aware, with every fix benchmarked on V8 and JavaScriptCore.";

export default defineConfig({
  title: "optilint",
  description,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: site },
  srcExclude: ["README.md"],
  head: [
    ["link", { rel: "icon", href: "/logo.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#ea580c" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "optilint" }],
    ["meta", { property: "og:title", content: "optilint: find and fix slow JavaScript and TypeScript" }],
    ["meta", { property: "og:description", content: description }],
  ],
  transformHead: ({ pageData }) => {
    const url = new URL(pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, ""), `${site}/`).toString();
    return [["link", { rel: "canonical", href: url }], ["meta", { property: "og:url", content: url }]];
  },
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/install", activeMatch: "^/(install|usage|configuration|integrations)" },
      { text: "Rules", link: "/rules", activeMatch: "^/(rules|reference)" },
      { text: "Changelog", link: "https://github.com/tjagithub/optilint/releases" },
    ],
    sidebar: [
      { text: "Guide", items: [
        { text: "Install", link: "/install" },
        { text: "Usage", link: "/usage" },
        { text: "Configuration", link: "/configuration" },
        { text: "Editors, CI and agents", link: "/integrations" },
      ] },
      { text: "Rules", items: [
        { text: "How fixes work", link: "/rules" },
        { text: "Rule reference", link: "/reference" },
      ] },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/tjagithub/optilint" },
      { icon: "npm", link: "https://www.npmjs.com/package/@optilint/cli" },
    ],
    editLink: { pattern: "https://github.com/tjagithub/optilint/edit/main/docs/:path", text: "Edit this page on GitHub" },
    search: { provider: "local" },
    outline: "deep",
    footer: { message: "Released under the MIT License." },
  },
});
