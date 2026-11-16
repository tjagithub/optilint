import path from "node:path";
import ts from "typescript";

export const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  strict: true,
  skipLibCheck: true,
};

export interface Project {
  /** The tsconfig used; undefined when none was found and defaults apply. */
  configPath?: string;
  options: ts.CompilerOptions;
  /** Ambient .d.ts files the project includes, type-checked but not linted. */
  ambient: string[];
}

const NO_PROJECT: Project = { options: DEFAULT_OPTIONS, ambient: [] };

/** Each file's tsconfig: `explicit` or the nearest above the file; a solution-style config (`files: []` +
 * `references`) resolves to the referenced project that lists the file, as tsserver does. */
export class ProjectResolver {
  private readonly parsed = new Map<string, ts.ParsedCommandLine>();
  private readonly nearest = new Map<string, string | undefined>();
  private readonly projects = new Map<string, Project>();

  constructor(private readonly explicit?: string) {}

  forFile(file: string): Project {
    const start = this.explicit ?? this.find(path.dirname(file));
    if (!start) return NO_PROJECT;
    const configPath = this.owner(start, path.resolve(file), new Set()) ?? start;
    let project = this.projects.get(configPath);
    if (!project) {
      const parsed = this.parse(configPath);
      const ambient = parsed.fileNames.filter((f) => /\.d\.[cm]?ts$/.test(f));
      project = { configPath, options: { ...DEFAULT_OPTIONS, ...parsed.options }, ambient };
      this.projects.set(configPath, project);
    }
    return project;
  }

  private find(dir: string): string | undefined {
    if (!this.nearest.has(dir)) this.nearest.set(dir, ts.findConfigFile(dir, ts.sys.fileExists));
    return this.nearest.get(dir);
  }

  private owner(configPath: string, file: string, seen: Set<string>): string | undefined {
    if (seen.has(configPath)) return undefined;
    seen.add(configPath);
    const parsed = this.parse(configPath);
    if (parsed.fileNames.some((f) => path.resolve(f) === file)) return configPath;
    for (const ref of parsed.projectReferences ?? []) {
      const found = this.owner(ts.resolveProjectReferencePath(ref), file, seen);
      if (found) return found;
    }
    return undefined;
  }

  private parse(configPath: string): ts.ParsedCommandLine {
    let parsed = this.parsed.get(configPath);
    if (!parsed) {
      const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
      if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
      parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath), undefined, configPath);
      this.parsed.set(configPath, parsed);
    }
    return parsed;
  }
}
