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

每个启用诊断的请求都会创建独立、初始值为零的 `tokens` 计数器，并随完成记录写入；并发请求不共享计数器，请求完成后的异步延续不会继续计入。诊断只记录计数和耗时，不记录参与计数的文本或内容指纹。旧记录可以没有 `tokens`，也可以只有原有的 9 个字段；reader 将缺失的测量报告为 unavailable，而不是零。

`tokens` 字段的含义如下：

| 字段                        | 定义                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `usageCalls`                | `getCurrentTokenUsage` 的调用次数；每次调用只进入下面三种路径之一。                                          |
| `providerUsage`             | 使用已有 provider token usage 的次数。                                                                       |
| `compactionReset`           | 因已有 usage 位于 compaction 边界之前或对应边界 summary 而返回零的次数。                                     |
| `fullHistoryFallback`       | 没有可用 provider usage、转而遍历全部消息估算的次数。                                                        |
| `fallbackMessages`          | 所有 full-history fallback 遍历的消息数之和；同一消息可在多次调用中重复计入。                                |
| `tokenizerCalls`            | 非空 `countTokens` 调用次数，**包含 cache hit**，不等于 tokenizer encode 次数。                              |
| `tokenizerChars`            | 这些调用输入的原始 UTF-16 code unit 数之和，包含 cache hit 和重复输入；不是字节数、唯一内容大小或 token 数。 |
| `tokenizerMs`               | 这些 `countTokens` 调用的总 elapsed time，包含指纹计算、cache 查找和实际 encode，完成记录保留三位小数。      |
| `tokenizerErrors`           | token 计数抛错并实际使用估算 fallback 的次数，不是普通 cache miss。                                          |
| `cacheHits` / `cacheMisses` | 成功完成 cache 查找时命中或未命中的次数；两者必须与 `cacheEvictions` 一起出现，才构成有效的 cache 测量。     |
| `cacheEvictions`            | 当前请求执行计数时触发的淘汰次数，不是共享 cache 的占用量或累计全局淘汰数。                                  |

内容计数 cache 由进程共享，最多保留 65,536 个内容指纹与精确计数，按 LRU 淘汰，不保留原文或失败后的估算值。该上限不是任意工作负载都能避免淘汰的保证；首次或被淘汰内容仍需编码，每次查找也仍需扫描文本生成指纹。其他请求及诊断范围外的计数会影响后续命中结果，但不会计入当前请求的计数器。旧 9 字段记录缺少 cache 测量，不应按零命中、零 miss 或零淘汰解释。计数器描述请求内的工作量，不足以单独证明端到端性能提升；比较时仍需结合相同工作负载下的完成耗时和 stage 耗时。

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
- `tokenWorkload`：`measuredRecords`、`unavailableRecords`、原有 9 字段的 `totals` 和 `fallbackRatio`（`fullHistoryFallback / usageCalls`）。只有包含完整、有效的原有 9 字段的记录才计入这些 totals 和比例；没有测量时 totals 为 `null`，没有测得 usage 调用时比例为 `null`。其 `cache` 子对象独立提供 `measuredRecords`、`unavailableRecords` 和 3 个 cache 字段的 `totals`：只有完整、有效的 cache 字段组才计入，没有 cache 测量时 totals 为 `null`。不提供共享 cache 占用量之和。缺少字段组表示 unavailable，完整且为零的字段组才是测得的零；任何已有但无效的原有字段或不完整、无效的 cache 字段组都会使整行被归为 malformed。
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

### 长历史重复计数与 transform 回放

从当前仓库根目录分别运行，每条命令都启动新的 Node.js 进程：

```bash
node --import tsx scripts/benchmark-long-history.ts
node --import tsx scripts/benchmark-long-history.ts --source /path/to/baseline-checkout
```

baseline 使用另一个相同 package 版本、已安装依赖的 checkout。`--source` 指定待测源码目录；仍使用当前 checkout 的同一个 benchmark 脚本，以保持合成输入和比较方式一致。脚本不修改待测源码；临时配置和状态目录在完成后清理。

脚本向 stdout 输出两条 JSON 结果：

- `exact-count`：对 3 个 session 的 1,200 段合成消息文本执行精确计数，报告输入字符总数、首次 `cold` 和随后 3 次 `warm` 的耗时及计数向量 hash。
- `transform`：回放 3 个 session、共 303 条消息的真实 transform，报告首次 `cold` 和随后 3 次 `warm` 的耗时、`output`、message refs 和 prune 状态的组合 hash，以及每个 session 的诊断计数器。旧源码没有 `tokens` 时，计数器为 `null`，不代表测得的零。

脚本会断言同一进程内每次 warm 的 hash 与该 operation 的 cold 一致；比较不同 checkout 时，也应确认 `exact-count` 的计数向量 hash 和 `transform` 的输出/refs/prune 组合 hash 一致，再解读耗时变化。`cold` 仅表示该 operation 的首次运行，不保证 tokenizer 或共享 cache 从未被先前 operation 使用，更不是进程冷启动时间。

该回放固定 wall clock，使用合成内容和 stubbed diagnostic sink，不测 provider/network latency 或日志落盘耗时，也不覆盖真实流量分布、进程间 cache 共享或 V2 event subscription 的性能。结果用于同一环境下的可重复对照，不是生产 latency、生产性能提升或诊断开销上限的保证。
