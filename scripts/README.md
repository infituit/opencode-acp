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

## Context diagnostics summary

### Runtime logging

Context diagnostics use the existing ACP `logLevel` and Logger sink; no new configuration is required. Daily logs are written to `$XDG_CONFIG_HOME/opencode/logs/acp/daily/YYYY-MM-DD.log`, falling back to `~/.config/opencode/logs/acp/daily/YYYY-MM-DD.log` when `XDG_CONFIG_HOME` is unset or empty.

- `info` records one JSON summary for each completed context request, including `ok` and `skipped` outcomes; failures are recorded at `ERROR`.
- `debug` also records request-start and stage breadcrumbs with session and trace IDs. **Debug logging also enables existing content snapshots, which may contain sensitive conversation or tool content; review logs before sharing them.**
- `warn` and `error` omit successful/skipped completion summaries but retain error summaries. `silent` disables diagnostics and file output.

Completion logging is best effort: process crashes, hard hangs, or write failures may leave no summary. A debug start without a completion does not by itself prove an unfinished request. Stage durations are elapsed wall time, exclusive within each lane, not exclusive CPU attribution. The `context` and `transform` lanes overlap because transform work is included in its parent context stage; do not add them together.

The current runtime does not collect token workload counters and omits `tokens`. The summary reader accepts optional counters for compatible records, but reports missing measurements as unavailable, not zero.

### Offline summary

Summarize ACP daily logs offline from the repository root:

```bash
npx tsx scripts/diagnostics-summary.ts /path/to/daily/2026-11-01.log
npx tsx scripts/diagnostics-summary.ts --session ses_example /path/to/daily/*.log
npx tsx scripts/diagnostics-summary.ts --help
```

The script reads the supplied files line by line and prints JSON to stdout. It does not start OpenCode, load runtime configuration, or modify files. Use `--` before paths beginning with a dash. It is a repository development tool, not part of the published package.

Only `diagnostics: context` completion events with `schemaVersion: 1` are aggregated. The expected daily-log envelope is:

```text
<ISO> INFO  diagnostics: context | <JSON> | v=<version>
```

Error completions may use `ERROR` instead of `INFO`. Other log messages are ignored. Invalid diagnostic envelopes or payloads increment `malformedDiagnosticLines`; unsupported numeric schema versions increment `unsupportedSchemaLines` and `unsupportedSchemas`, without contributing to the metrics. These line counters cover all supplied files, including when `--session` filters valid records.

The JSON summary includes:

- `completionCount` and `status`: unique observed completions, split into `ok`, `skipped`, and `error`.
- `totalMs`: exact nearest-rank `p50`, `p95`, and `max` across those completions. Nearest rank uses `ceil(percentile * count)`; empty samples produce `null`.
- `stageMs.context` and `stageMs.transform`: stages ranked by descending total milliseconds, with `records`, `totalMs`, and `meanMs`. A stage's mean includes only records containing that stage. The transform lane is child work included in the context lane: **do not add the lanes together** or treat their stage totals as independent wall time.
- `tokenWorkload`: `measuredRecords`, `unavailableRecords`, validated counter `totals`, and `fallbackRatio` (`fullHistoryFallback / usageCalls`). Counters may be absent; missing counters are unavailable, never measured zeros. Only records containing the complete validated `tokens` object contribute to token totals and the ratio. Totals are `null` when no records contain counters; the ratio is `null` when there are no measured usage calls. A present but invalid `tokens` object makes the diagnostic line malformed.
- `versions`: completion counts by plugin version. Supported schema records can span plugin versions; unsupported schema records are excluded rather than mixed silently.
- `duplicateRecords`, `filteredRecords`, and `ignoredLines`: excluded duplicate completions, valid records outside the requested session, and unrelated lines.

Overlapping input files are deduplicated by `traceId`; the first valid record in input order wins. Malformed and unsupported lines are counted per occurrence, not deduplicated. Missing completion records do not establish unfinished requests or concurrency; the summary makes neither inference.

Input is streamed, but aggregation is not constant-memory: exact quantiles retain one duration and deduplication retains one trace ID per selected unique completion, plus aggregates for distinct stages and versions. Split very large inputs into smaller analysis windows when needed.

For in-process analysis and `node:test`, importing `scripts/diagnostics-summary.ts` does not run the CLI. `parseDiagnosticLine(line)` classifies one line; `summarizeDiagnostics(lines, sessionId?)` returns a summary from a synchronous iterable; `DiagnosticsAggregator` exposes `addLine(line)` and `summary()` for incremental consumers.

### Tests and synthetic benchmark

Run the diagnostics tests and benchmark from the repository root:

```bash
node --import tsx --test tests/diagnostics*.test.ts
node --import tsx scripts/benchmark-diagnostics.ts
```

The benchmark exercises the real transform with synthetic histories and a stubbed diagnostics sink, excluding disk I/O. After warm-up, it compares three samples per mode with alternating execution order and checks that transformed outputs match. Its timings are a synthetic comparison, not a production-overhead guarantee or exclusive CPU measurement.
