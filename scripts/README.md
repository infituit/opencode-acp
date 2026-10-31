# ACP Prompt Preview

Preview the bundled ACP prompts from the repository root:

```bash
npm run acp -- --help
npm run acp -- --list
npm run acp -- --show compress-range
npm run acp -- --system
```

## Options

| Option         | Output                                    |
| -------------- | ----------------------------------------- |
| `--list`       | Available prompt keys                     |
| `--show <key>` | Prompt text for the selected key          |
| `--system`     | System prompt with the default extensions |

Running without options also prints the system prompt. Use `--list` for the keys supported by the current prompt store:

- `system`
- `compress-range`
- `context-limit-nudge`
- `turn-nudge`
- `iteration-nudge`

The preview uses the bundled defaults; it does not load ACP configuration or enable custom prompt overrides. It does not start OpenCode and is not runtime verification of the plugin. This development tool is not included in the published package.
