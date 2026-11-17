import type ts from "typescript";
import { type FileResult, type FileSettings, lint } from "./core/engine.ts";
import { ruleByName } from "./rules/index.ts";

/** One program's worth of linting, in plain data so it can go to a worker thread. */
export interface Job {
  files: string[];
  /** Rule names, in dispatch order. */
  rules: string[];
  fix: boolean;
  settings: [string, FileSettings][];
  compilerOptions: ts.CompilerOptions;
  extraRoots: string[];
  /** File texts that override the disk (a buffer from stdin or an editor). */
  sources?: [string, string][];
}

export interface RuleError {
  rule: string;
  file: string;
  message: string;
}

export interface JobResult {
  results: FileResult[];
  errors: RuleError[];
}

export function lintJob(job: Job): JobResult {
  const errors: RuleError[] = [];
  const settings = new Map(job.settings);
  const results = lint(job.files, {
    rules: job.rules.map((name) => ruleByName.get(name)!),
    fix: job.fix,
    settings: (f) => settings.get(f)!,
    compilerOptions: job.compilerOptions,
    extraRoots: job.extraRoots,
    onRuleError: (rule, file, e) => errors.push({ rule, file, message: (e as Error).message }),
  }, new Map(job.sources));
  return { results, errors };
}
