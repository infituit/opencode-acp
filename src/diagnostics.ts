import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { Logger } from "./logger"

const requests = new AsyncLocalStorage<ContextDiagnostic>()
const instanceId = randomUUID()
let sequence = 0
const milliseconds = (value: number) => Number(value.toFixed(3))

/** Sequential, exclusive stages within a lane; different lanes may overlap. */
class StageTimeline {
    readonly stageMs: Record<string, number> = {}
    private checkpointAt = performance.now()
    private ended = false

    constructor(
        public stage: string,
        private readonly onStage: (stage: string) => void,
    ) {
        onStage(stage)
    }

    next(stage: string) {
        if (this.ended) return
        const now = performance.now()
        this.stageMs[this.stage] = (this.stageMs[this.stage] ?? 0) + now - this.checkpointAt
        this.checkpointAt = now
        this.stage = stage
        this.onStage(stage)
    }

    end() {
        if (this.ended) return
        this.stageMs[this.stage] =
            (this.stageMs[this.stage] ?? 0) + performance.now() - this.checkpointAt
        this.ended = true
    }

    snapshot() {
        return Object.fromEntries(
            Object.entries(this.stageMs).map(([key, ms]) => [key, milliseconds(ms)]),
        )
    }
}

export class ContextDiagnostic {
    readonly traceId = `${instanceId}-${++sequence}`
    readonly startedAt = performance.now()
    readonly counts: {
        inputMessages?: number
        outputMessages?: number
        blocks?: number
        activeBlocks?: number
    } = {}
    private readonly lanes = new Map<string, StageTimeline>()
    private status: "ok" | "skipped" | "error" = "ok"
    private skipReason?: string
    private failedStage?: string
    private finished = false

    constructor(
        readonly sessionId: string,
        private readonly logger: Logger,
    ) {}

    timeline(lane: "context" | "transform", initialStage: string) {
        const timeline = new StageTimeline(initialStage, (stage) => {
            this.logger.debug("Context diagnostic stage", {
                sessionId: this.sessionId,
                traceId: this.traceId,
                lane,
                stage,
            })
        })
        this.lanes.set(lane, timeline)
        return timeline
    }

    skip(reason: "empty_history" | "internal_agent" | "subagent_disabled") {
        this.status = "skipped"
        this.skipReason = reason
    }

    fail(lane: "context" | "transform") {
        this.status = "error"
        this.failedStage ??= `${lane}.${this.lanes.get(lane)?.stage ?? "unknown"}`
    }

    get active() {
        return !this.finished
    }

    finish() {
        if (this.finished) return
        this.finished = true
        for (const lane of this.lanes.values()) lane.end()
        try {
            void this.logger
                .diagnostic(
                    "context",
                    {
                        schemaVersion: 1,
                        instanceId,
                        pid: process.pid,
                        sessionId: this.sessionId,
                        traceId: this.traceId,
                        status: this.status,
                        skipReason: this.skipReason,
                        failedStage: this.failedStage,
                        totalMs: milliseconds(performance.now() - this.startedAt),
                        counts: this.counts,
                        stageMs: Object.fromEntries(
                            [...this.lanes].map(([name, lane]) => [name, lane.snapshot()]),
                        ),
                    },
                    this.status === "error" ? "error" : "info",
                )
                ?.catch(() => {})
        } catch {
            // Diagnostic failures must never replace a request's result or exception.
        }
    }
}

export function currentDiagnostic(): ContextDiagnostic | undefined {
    const request = requests.getStore()
    return request?.active ? request : undefined
}

/** No global mutable counters: concurrent sessions and nested async work remain isolated. */
export async function diagnoseContext<T>(
    logger: Logger,
    sessionId: string,
    callback: (diagnostic: ContextDiagnostic | undefined) => Promise<T>,
): Promise<T> {
    if (logger.level === "silent") return callback(undefined)
    const diagnostic = new ContextDiagnostic(sessionId, logger)
    return requests.run(diagnostic, async () => {
        logger.debug("Context diagnostic start", { sessionId, traceId: diagnostic.traceId })
        try {
            return await callback(diagnostic)
        } catch (error) {
            diagnostic.fail("context")
            throw error
        } finally {
            diagnostic.finish()
        }
    })
}
