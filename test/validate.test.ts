import { describe, expect, test } from "bun:test";
import { TOP_KEYS, validate } from "../src/validate.ts";

describe("validate", () => {
  test("reports each problem at its path, in the order of the file", () => {
    const config = {
      tir: "typed", $schema: 1, extends: "x", files: { include: "a", ignre: [] }, tier: "typd", obscure: "no",
      minImpact: "huge", maxSlowdown: "10", domains: { react: "yes", vue: "on" }, rules: { "fliter-first": "on", arrays: { "date-now": "on" } },
      overrides: [1, {}, { include: ["a"], tier: "x", obscure: 1, extra: 1 }],
    };
    expect(validate(config)).toEqual([
      'config: unknown key "tir" (did you mean "tier"?)',
      "$schema: expected a string",
      "extends: expected an array of strings",
      "files.include: expected an array of strings",
      'files: unknown key "ignre" (did you mean "ignore"?)',
      'tier: expected one of "exact", "typed", "assumed", got "typd" (did you mean "typed"?)',
      "obscure: expected true or false",
      'minImpact: expected one of "low", "medium", "high", got "huge" (did you mean "high"?)',
      'maxSlowdown: expected a percentage such as "10%", or "any", got "10"',
      'domains.react: expected one of "auto", "on", "off", got "yes"',
      'domains: unknown key "vue"',
      'rules.fliter-first: unknown rule or group (did you mean "filter-first"?)',
      'rules.arrays.date-now: rule is in group "misc", not "arrays"',
      "overrides[0]: expected an object",
      'overrides[1]: missing "include"',
      'overrides[2].tier: expected one of "exact", "typed", "assumed", got "x"',
      "overrides[2].obscure: expected true or false",
      'overrides[2]: unknown key "extra"',
    ]);
  });

  test("valid configs and the key list", () => {
    expect(validate({})).toEqual([]);
    expect(validate({ files: { include: ["src/**"] }, maxSlowdown: "5%", domains: { react: "off", typescript: "auto" }, overrides: [{ include: ["test/**"], rules: { async: "off" } }] })).toEqual([]);
    expect(validate([])).toEqual(["config must be a JSON object"]);
    expect(TOP_KEYS).toEqual(["$schema", "extends", "files", "ignore", "tier", "obscure", "minImpact", "maxSlowdown", "domains", "rules", "overrides"]);
  });
});
