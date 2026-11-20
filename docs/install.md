# Install

optilint runs on Node 20+ or Bun. It reads your `tsconfig.json` and type-checks with your project's TypeScript setup.

## Run it once

::: code-group

```sh [npm]
npx @optilint/cli src
```

```sh [bun]
bunx @optilint/cli src
```

```sh [pnpm]
pnpm dlx @optilint/cli src
```

```sh [yarn]
yarn dlx @optilint/cli src
```

:::

The rest of these docs write `optilint`; with a runner, that is `npx @optilint/cli` (or `bunx`, …).

## Pin it in a project

For CI, or to keep everyone on one version, add it as a dev dependency:

::: code-group

```sh [npm]
npm install --save-dev @optilint/cli
```

```sh [pnpm]
pnpm add -D @optilint/cli
```

```sh [bun]
bun add -d @optilint/cli
```

:::

The package installs an `optilint` command. Run `optilint` in the project root: with no config it lints every JS and TS file git lists, with the recommended rules.

## Editors and agents

- **VS Code:** install the optilint extension for diagnostics, quick fixes and a sidebar grouped by tier.
- **Claude Code and other MCP clients:** `claude mcp add optilint -- npx @optilint/cli --mcp`.
- **Agent skill:** the repository ships `skills/optilint/SKILL.md`, which teaches an agent how to treat each tier.

See [Editors, CI and agents](integrations.md) for JSON and SARIF output.

Next: [Usage](usage.md).
