import assert from "node:assert/strict"
import { test } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDiagnosticLine, summarizeDiagnostics } from "../scripts/diagnostics-summary"

const record = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    instanceId: "instance",
    pid: 1,
    sessionId: "session",
    traceId: "trace",
    status: "ok",
    totalMs: 10,
    counts: { inputMessages: 2 },
    stageMs: { context: { transformMessages: 8 }, transform: { prePruneTokens: 6 } },
    version: "fixture",
    ...overrides,
})
const line = (payload: Record<string, unknown>) =>
    `2026-10-31T00:00:00.000Z INFO  diagnostics: context | ${JSON.stringify(payload)} | v=fixture`

test("summary classifies malformed and unsupported data without inventing measurements", () => {
    const invalid = [
        "2026-10-31T00:00:00.000Z INFO diagnostics: context | broken | v=fixture",
        line(record({ totalMs: -1 })),
        line(record({ stageMs: { unknown: { stage: 1 } } })),
        line(record({ tokens: { usageCalls: 0 } })),
    ]
    for (const value of invalid) assert.equal(parseDiagnosticLine(value).kind, "malformed")
    const result = summarizeDiagnostics([
        "ordinary log",
        ...invalid,
        line(record({ schemaVersion: 2 })),
        line(record()),
    ])
    assert.equal(result.completionCount, 1)
    assert.equal(result.malformedDiagnosticLines, invalid.length)
    assert.equal(result.unsupportedSchemaLines, 1)
    assert.equal(result.ignoredLines, 1)
    assert.deepEqual(result.tokenWorkload, {
        measuredRecords: 0,
        unavailableRecords: 1,
        totals: null,
        fallbackRatio: null,
    })
    assert.equal(summarizeDiagnostics([]).totalMs.p95, null)
})

test("summary filters sessions, deduplicates completions and keeps overlapping lanes separate", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
        line(record({ traceId: `t-${i}`, totalMs: i + 1 })),
    )
    const result = summarizeDiagnostics(
        [
            ...records,
            records[0],
            line(record({ traceId: "other", sessionId: "other" })),
            line(
                record({
                    traceId: "failure",
                    status: "error",
                    totalMs: 21,
                    failedStage: "transform.prePruneTokens",
                }),
            ),
        ],
        "session",
    )
    assert.equal(result.completionCount, 21)
    assert.deepEqual(result.status, { ok: 20, skipped: 0, error: 1 })
    assert.equal(result.duplicateRecords, 1)
    assert.equal(result.filteredRecords, 1)
    assert.deepEqual(result.totalMs, { p50: 11, p95: 20, max: 21 })
    assert.equal(result.stageMs.context[0].totalMs, 21 * 8)
    assert.equal(result.stageMs.transform[0].totalMs, 21 * 6)
})

test("optional token measurements are aggregated only when present and complete", () => {
    const tokens = {
        usageCalls: 4,
        providerUsage: 1,
        compactionReset: 1,
        fullHistoryFallback: 2,
        fallbackMessages: 10,
        tokenizerCalls: 20,
        tokenizerChars: 1000,
        tokenizerMs: 30,
        tokenizerErrors: 0,
    }
    const result = summarizeDiagnostics([
        line(record({ tokens })),
        line(record({ traceId: "unmeasured" })),
    ])
    assert.deepEqual(result.tokenWorkload, {
        measuredRecords: 1,
        unavailableRecords: 1,
        totals: tokens,
        fallbackRatio: 0.5,
    })
})

test("summary CLI is read-only, supports session filtering and rejects missing files", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-summary-test-"))
    try {
        const path = join(sandbox, "daily.log")
        const input = `${line(record())}\n${line(record({ traceId: "other", sessionId: "other" }))}\n`
        await writeFile(path, input)
        const run = promisify(execFile)
        const { stdout } = await run(process.execPath, [
            "--import",
            "tsx",
            "scripts/diagnostics-summary.ts",
            "--session",
            "session",
            path,
            path,
        ])
        const summary = JSON.parse(stdout)
        assert.equal(summary.completionCount, 1)
        assert.equal(summary.duplicateRecords, 1)
        assert.equal(summary.filteredRecords, 2)
        assert.equal(await readFile(path, "utf8"), input)
        await assert.rejects(
            run(process.execPath, [
                "--import",
                "tsx",
                "scripts/diagnostics-summary.ts",
                join(sandbox, "missing.log"),
            ]),
        )
    } finally {
        await rm(sandbox, { recursive: true, force: true })
    }
})
