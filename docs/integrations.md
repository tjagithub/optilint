# Editors, CI and agents

## Output for other tools

- `--format json` prints `{ "version": 1, "tool": {...}, "findings": [...] }`, described by `output.schema.json` (`optilint --print-schema output`). Each finding has its `group`, `impact`, optional `severity`, start and end positions, and `fix: { tier, assumes?, obscure?, edits } | null`. Edit offsets count UTF-16 code units, as editors do.
- `--format sarif` prints SARIF 2.1.0 with fixes as replacements, for GitHub code scanning and other SARIF viewers.
- `--list-rules --format json` prints every rule's metadata.
- `--stdin-filename path/to/file.ts` lints stdin as that file; with `--fix` it prints the fixed text. Editors use this for unsaved buffers.
- The exit code is 1 when findings remain (findings set to `info` do not count) and 2 on usage errors.

## VS Code

The optilint extension shows findings as diagnostics with quick fixes, adds a fix-all command and a sidebar grouped by tier, and gives `optilint.json` completion. It ships its own copy of optilint.

## Coding agents

- **Skill:** `skills/optilint/SKILL.md` ([Agent Skills](https://agentskills.io) format) teaches an agent the tiers: apply exact and typed fixes, check each assumed fix's assumption first, and leave report-only findings unless the code is hot. The repo is also a Claude Code plugin (`.claude-plugin/plugin.json`) that ships just this skill.
- **MCP server:** `optilint --mcp` serves three tools on stdio: `lint` (files or a code snippet), `fix` (returns fixed text or a diff; writes files only with `write: true`) and `rules`. Paths must be inside the directory it runs in. Add it to Claude Code with `claude mcp add optilint -- optilint --mcp`.
- The VS Code extension registers both for Copilot and other VS Code agents.

An agent with a shell does as well with the CLI and the skill, and does not pay for the MCP tool descriptions in every session.
