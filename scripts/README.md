# ACP CLI

Dev tool for previewing prompt outputs.

## Usage

```bash
bun run acp [TYPE]
```

## Types

| Flag                 | Description                              |
| -------------------- | ---------------------------------------- |
| `--system`           | System prompt                            |
| `--nudge`            | Standard nudge prompt                    |
| `--compress-nudge`   | Context-limit compress nudge             |
| `--context-tools`    | Example `<context-pressure-tools>` block |
| `--compress-context` | Example `<compress-context>` block       |
| `--cooldown`         | Cooldown context-info block              |

## Examples

```bash
bun run acp --system
bun run acp --nudge
bun run acp --context-tools
```

## Purpose

This CLI does not ship with the plugin. It is for local DX while iterating on injected prompts.
