import { TIERS } from "./core/fix.ts";
import { allRules, groups } from "./rules/index.ts";
import type { Rule } from "./core/types.ts";
import { FLOORS, IMPACTS, LEVELS, PRESETS } from "./validate.ts";

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const strings = { type: "array", items: { type: "string" } };
const enumOf = (values: readonly string[], description: string) => ({ description, enum: values });

function ruleDoc(r: Rule) {
  const fix = r.tiers.length ? `Fixes: ${r.tiers.join(" or ")}${r.obscure ? " (obscure)" : ""}.` : "Report only.";
  const off = r.recommended === false ? " Not in the recommended preset." : "";
  return `${r.description}\n\n${r.why}\n\n${r.impact} impact. ${fix}${off}`;
}

const ruleProps = (rules: readonly Rule[]) =>
  Object.fromEntries(rules.map((r) => [r.name, { ...ref("RuleValue"), markdownDescription: ruleDoc(r) }]));

/** JSON Schema for optilint.json / optilint.jsonc (and the "optilint" key of package.json). */
export function configSchema() {
  const groupProps = Object.fromEntries(groups.map((g) => {
    const own = allRules.filter((r) => r.group === g);
    return [g, {
      description: `The ${g} group: ${own.map((r) => r.name).join(", ")}. A level for all of them, or settings per rule.`,
      anyOf: [ref("Level"), { type: "object", properties: ruleProps(own), additionalProperties: false }],
    }];
  }));
  const tier = enumOf(TIERS, "The highest tier --fix applies: exact (same behaviour for every input), typed (for every input the types allow) or assumed (relies on a stated assumption). Default: typed.");
  const obscure = { type: "boolean", description: "Let --fix apply fixes that are correct but hard to read, such as `x | 0`. Default: false." };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "optilint configuration",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      extends: { ...strings, description: "Config files to start from, relative to this one; later ones and this file win." },
      files: {
        type: "object", additionalProperties: false,
        properties: {
          include: { ...strings, description: "Globs of files to lint, relative to this file. Default: every JS/TS file." },
          ignore: { ...strings, description: "Globs of files or folders to skip, relative to this file." },
        },
      },
      ignore: { ...strings, description: "Same as files.ignore." },
      tier,
      obscure,
      minImpact: enumOf(IMPACTS, "Only report rules with at least this impact. Default: low."),
      maxSlowdown: {
        type: "string", pattern: "^(\\d+(\\.\\d+)?%|any)$",
        description: "Skip rules whose fix measured more than this much slower than the original code on some engine, compiler tier or input size the bench covers. Default \"10%\", to allow for measurement noise; \"0%\" drops every fix that was slower anywhere; \"any\" runs them all. Rules without a measured fix always run.",
      },
      rules: ref("Rules"),
      overrides: {
        description: "Settings for some files, applied in order after the rest of the config.",
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["include"],
          properties: { include: { ...strings, description: "Globs relative to this file." }, tier, obscure, rules: ref("Rules") },
        },
      },
    },
    $defs: {
      Level: enumOf(LEVELS, "off disables the rule; on enables it with its default severity; info, warn and error also set the severity."),
      RuleValue: {
        anyOf: [ref("Level"), {
          type: "object", additionalProperties: false, required: ["level"],
          properties: {
            level: ref("Level"),
            tier: enumOf(FLOORS, "Treat this rule's fixes as at least this tier (it can only raise them), or none to drop them."),
          },
        }],
      },
      Rules: {
        type: "object",
        description: "Applied in order: preset, then groups, then single rules.",
        additionalProperties: false,
        properties: {
          preset: enumOf(PRESETS, "The starting set: recommended (default), all, or none."),
          ...groupProps,
          ...ruleProps(allRules),
        },
      },
    },
  };
}

/** JSON Schema for `--format json` output. */
export function outputSchema() {
  const pos = { type: "integer", minimum: 1 };
  const offset = { type: "integer", minimum: 0, description: "UTF-16 code units from the start of the file." };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "optilint --format json output",
    type: "object",
    required: ["version", "tool", "findings"],
    properties: {
      version: { const: 1 },
      tool: { type: "object", properties: { name: { const: "optilint" }, version: { type: "string" } } },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["rule", "group", "impact", "message", "file", "line", "col", "endLine", "endCol", "start", "end", "fix"],
          properties: {
            rule: { type: "string" }, group: { type: "string" }, impact: { enum: IMPACTS },
            severity: { enum: ["info", "warn", "error"], description: "Only when the config sets a level." },
            message: { type: "string" }, description: { type: "string" }, file: { type: "string" },
            line: pos, col: pos, endLine: pos, endCol: { ...pos, description: "Exclusive, 1-based." },
            start: offset, end: offset,
            fix: {
              oneOf: [{ type: "null" }, {
                type: "object", required: ["tier", "edits"],
                properties: {
                  tier: { enum: TIERS }, assumes: { type: "string" }, obscure: { type: "boolean" },
                  edits: {
                    type: "array",
                    items: { type: "object", required: ["start", "end", "text"], properties: { start: offset, end: offset, text: { type: "string" } } },
                  },
                },
              }],
            },
          },
        },
      },
    },
  };
}
