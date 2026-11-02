#!/usr/bin/env npx tsx

import { createReadStream } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"

const TOKEN_KEYS = [
    "usageCalls",
    "providerUsage",
    "compactionReset",
    "fullHistoryFallback",
    "fallbackMessages",
    "tokenizerCalls",
    "tokenizerChars",
    "tokenizerMs",
    "tokenizerErrors",
] as const

type TokenCounters = Record<(typeof TOKEN_KEYS)[number], number>
type Lane = "context" | "transform"

export interface ContextDiagnosticRecord {
    schemaVersion: 1
    instanceId: string
    pid: number
    sessionId: string
    traceId: string
    status: "ok" | "skipped" | "error"
    skipReason?: string
    failedStage?: string
    totalMs: number
    counts: Record<string, number>
    stageMs: Partial<Record<Lane, Record<string, number>>>
    tokens?: TokenCounters
    version: string
}

export type DiagnosticLineResult =
    | { kind: "ignored" }
    | { kind: "malformed" }
    | { kind: "unsupported"; schemaVersion: number }
    | { kind: "diagnostic"; record: ContextDiagnosticRecord }

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonnegativeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isNumberMap(value: unknown): value is Record<string, number> {
    return isObject(value) && Object.values(value).every(isNonnegativeNumber)
}

/** Parse only the dedicated daily-log event; unrelated log messages are ignored. */
export function parseDiagnosticLine(line: string): DiagnosticLineResult {
    if (!/^\S+\s+\S+\s+diagnostics:\s*context(?:\s|\||$)/.test(line)) {
        return { kind: "ignored" }
    }
    const match = line.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(?:INFO|ERROR)\s+diagnostics: context \| (.+) \| v=(\S+)\s*$/,
    )
    if (!match || !Number.isFinite(Date.parse(match[1]))) return { kind: "malformed" }

    let payload: unknown
    try {
        payload = JSON.parse(match[2])
    } catch {
        return { kind: "malformed" }
    }
    if (!isObject(payload) || !Number.isInteger(payload.schemaVersion)) {
        return { kind: "malformed" }
    }
    if (payload.schemaVersion !== 1) {
        return { kind: "unsupported", schemaVersion: payload.schemaVersion as number }
    }
    if (
        !["instanceId", "sessionId", "traceId", "version"].every(
            (key) => typeof payload[key] === "string" && payload[key].length > 0,
        ) ||
        payload.version !== match[3] ||
        !isNonnegativeNumber(payload.pid) ||
        !Number.isInteger(payload.pid) ||
        !["ok", "skipped", "error"].includes(payload.status as string) ||
        !isNonnegativeNumber(payload.totalMs) ||
        !isNumberMap(payload.counts) ||
        !isObject(payload.stageMs) ||
        !Object.entries(payload.stageMs).every(
            ([lane, stages]) => (lane === "context" || lane === "transform") && isNumberMap(stages),
        ) ||
        (payload.skipReason !== undefined && typeof payload.skipReason !== "string") ||
        (payload.failedStage !== undefined && typeof payload.failedStage !== "string")
    ) {
        return { kind: "malformed" }
    }
    if (
        payload.tokens !== undefined &&
        (!isObject(payload.tokens) ||
            !TOKEN_KEYS.every((key) =>
                isNonnegativeNumber((payload.tokens as Record<string, unknown>)[key]),
            ))
    ) {
        return { kind: "malformed" }
    }
    return { kind: "diagnostic", record: payload as unknown as ContextDiagnosticRecord }
}

interface StageTotal {
    name: string
    records: number
    totalMs: number
    meanMs: number
}

/** nearest-rank quantiles: rank = ceil(percentile * sample count). */
export function nearestRank(values: readonly number[], percentile: number): number | null {
    if (!(percentile > 0 && percentile <= 1)) throw new Error("Percentile must be in (0, 1]")
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.ceil(percentile * sorted.length) - 1]
}

/** In-memory aggregation only; input files and plugin state are never changed. */
export class DiagnosticsAggregator {
    private readonly seenTraceIds = new Set<string>()
    private readonly durations: number[] = []
    private readonly stages: Record<Lane, Map<string, { records: number; totalMs: number }>> = {
        context: new Map(),
        transform: new Map(),
    }
    private readonly versions = new Map<string, number>()
    private readonly unsupportedSchemas = new Map<number, number>()
    private readonly statuses = { ok: 0, skipped: 0, error: 0 }
    private readonly tokenTotals = Object.fromEntries(
        TOKEN_KEYS.map((key) => [key, 0]),
    ) as TokenCounters
    private measuredTokenRecords = 0
    private malformedLines = 0
    private ignoredLines = 0
    private duplicateRecords = 0
    private filteredRecords = 0

    constructor(private readonly sessionId?: string) {}

    addLine(line: string): void {
        const result = parseDiagnosticLine(line)
        switch (result.kind) {
            case "ignored":
                this.ignoredLines++
                return
            case "malformed":
                this.malformedLines++
                return
            case "unsupported":
                this.unsupportedSchemas.set(
                    result.schemaVersion,
                    (this.unsupportedSchemas.get(result.schemaVersion) ?? 0) + 1,
                )
                return
        }
        const record = result.record
        if (this.sessionId !== undefined && record.sessionId !== this.sessionId) {
            this.filteredRecords++
            return
        }
        if (this.seenTraceIds.has(record.traceId)) {
            this.duplicateRecords++
            return
        }
        this.seenTraceIds.add(record.traceId)
        this.durations.push(record.totalMs)
        this.statuses[record.status]++
        this.versions.set(record.version, (this.versions.get(record.version) ?? 0) + 1)
        for (const lane of ["context", "transform"] as const) {
            for (const [name, ms] of Object.entries(record.stageMs[lane] ?? {})) {
                const stage = this.stages[lane].get(name) ?? { records: 0, totalMs: 0 }
                stage.records++
                stage.totalMs += ms
                this.stages[lane].set(name, stage)
            }
        }
        if (record.tokens !== undefined) {
            this.measuredTokenRecords++
            for (const key of TOKEN_KEYS) this.tokenTotals[key] += record.tokens[key]
        }
    }

    summary() {
        const rankStages = (lane: Lane): StageTotal[] =>
            [...this.stages[lane]]
                .map(([name, stage]) => ({
                    name,
                    ...stage,
                    meanMs: stage.totalMs / stage.records,
                }))
                .sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name))
        const sorted = [...this.durations].sort((a, b) => a - b)
        const quantile = (percentile: number) =>
            sorted.length ? sorted[Math.ceil(percentile * sorted.length) - 1] : null
        return {
            schemaVersion: 1,
            sessionId: this.sessionId ?? null,
            completionCount: this.durations.length,
            status: { ...this.statuses },
            totalMs: { p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) ?? null },
            stageMs: { context: rankStages("context"), transform: rankStages("transform") },
            tokenWorkload: {
                measuredRecords: this.measuredTokenRecords,
                unavailableRecords: this.durations.length - this.measuredTokenRecords,
                totals: this.measuredTokenRecords ? { ...this.tokenTotals } : null,
                fallbackRatio:
                    this.tokenTotals.usageCalls > 0
                        ? this.tokenTotals.fullHistoryFallback / this.tokenTotals.usageCalls
                        : null,
            },
            versions: Object.fromEntries(this.versions),
            malformedDiagnosticLines: this.malformedLines,
            unsupportedSchemaLines: [...this.unsupportedSchemas.values()].reduce(
                (sum, n) => sum + n,
                0,
            ),
            unsupportedSchemas: Object.fromEntries(this.unsupportedSchemas),
            duplicateRecords: this.duplicateRecords,
            filteredRecords: this.filteredRecords,
            ignoredLines: this.ignoredLines,
        }
    }
}

/** Pure, synchronous entry point for fixtures and node:test consumers. */
export function summarizeDiagnostics(lines: Iterable<string>, sessionId?: string) {
    const aggregator = new DiagnosticsAggregator(sessionId)
    for (const line of lines) aggregator.addLine(line)
    return aggregator.summary()
}

const HELP = `ACP Context Diagnostics Summary

Usage:
  npx tsx scripts/diagnostics-summary.ts [--session <id>] <log-file> [<log-file> ...]

Reads daily logs offline and prints a JSON summary to stdout. No files are changed.
Use -- before a file path that starts with a dash. Overlapping files are deduplicated
by traceId (first valid record wins). --help or -h prints this message.
`

async function main(args: string[]): Promise<void> {
    const files: string[] = []
    let sessionId: string | undefined
    let positional = false
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (!positional && (arg === "--help" || arg === "-h")) {
            console.log(HELP)
            return
        } else if (!positional && arg === "--") {
            positional = true
        } else if (!positional && arg === "--session") {
            const value = args[++i]
            if (!value || value.startsWith("--") || sessionId !== undefined) {
                throw new Error(
                    "--session requires one nonempty session ID and may be used only once",
                )
            }
            sessionId = value
        } else if (!positional && arg.startsWith("-")) {
            throw new Error(`Unknown option: ${arg}`)
        } else {
            files.push(arg)
        }
    }
    if (files.length === 0) throw new Error("Provide at least one log file. Use --help for usage.")
    const aggregator = new DiagnosticsAggregator(sessionId)
    for (const file of files) {
        const input = createReadStream(file, { encoding: "utf8" })
        const lines = createInterface({ input, crlfDelay: Infinity })
        // readline's async iterator does not forward input stream errors.
        let inputError: Error | undefined
        input.on("error", (error) => {
            inputError = error
            lines.close()
        })
        try {
            for await (const line of lines) aggregator.addLine(line)
            if (inputError) throw inputError
        } catch (error) {
            throw new Error(
                `Cannot summarize ${file}: ${error instanceof Error ? error.message : String(error)}`,
            )
        } finally {
            lines.close()
            input.destroy()
        }
    }
    console.log(JSON.stringify(aggregator.summary(), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    })
}
