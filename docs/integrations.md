# Editors, CI and agents

## Output for other tools

- `--format json` prints `{ "version": 1, "tool": {...}, "findings": [...] }`, described by `output.schema.json` (`optilint --print-schema output`). Each finding has its `group`, `impact`, optional `severity`, start and end positions, and `fix: { tier, assumes?, obscure?, edits } | null`. Edit offsets count UTF-16 code units, as editors do.
- `--format github` prints one [workflow command](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands) per finding (`::warning file=…,line=…::message`), which GitHub Actions shows as annotations on the run and on the PR diff, with no code scanning setup. A finding's `severity` picks error, warning or notice; without one, high and medium impact are warnings and low is a notice.
- `--format sarif` prints SARIF 2.1.0 with fixes as replacements, for GitHub code scanning and other SARIF viewers.
- `--list-rules --format json` prints every rule's metadata.
- `--stdin-filename path/to/file.ts` lints stdin as that file; with `--fix` it prints the fixed text. Editors use this for unsaved buffers.
- The exit code is 1 when findings remain (findings set to `info` do not count) and 2 on usage errors.

## GitHub Actions

[optilint-action](https://github.com/tjagithub/optilint-action) runs optilint on a pull request and shows its findings as annotations on the diff:

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false
- uses: tjagithub/optilint-action@v0
```

Inputs: `paths`, `version`, `working-directory`, `min-impact`, `fail-on` (`findings`, `error` or `never`), `sarif` (also upload to code scanning; needs `security-events: write`) and `args`. It only reports; apply fixes where you can review them.

## VS Code

The optilint extension shows findings as diagnostics with quick fixes, adds a fix-all command and a sidebar grouped by tier, and gives `optilint.json` completion. It ships its own copy of optilint.

## Coding agents

- **Skill:** `skills/optilint/SKILL.md` ([Agent Skills](https://agentskills.io) format) teaches an agent the tiers: apply exact and typed fixes, check each assumed fix's assumption first, and leave report-only findings unless the code is hot. The repo is also a Claude Code plugin (`.claude-plugin/plugin.json`) that ships just this skill.
- **MCP server:** `optilint --mcp` serves three tools on stdio: `lint` (files or a code snippet), `fix` (returns fixed text or a diff; writes files only with `write: true`) and `rules`. Paths must be inside the directory it runs in. Add it to Claude Code with `claude mcp add optilint -- npx -y @optilint/cli --mcp`.
- The VS Code extension registers both for Copilot and other VS Code agents.

An agent with a shell does as well with the CLI and the skill, and does not pay for the MCP tool descriptions in every session.
