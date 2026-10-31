import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setImmediate } from "node:timers/promises"
import { ContextDiagnostic, currentDiagnostic, diagnoseContext } from "../src/diagnostics"
import { Logger, type LogLevel } from "../src/logger"

function capture(level: LogLevel = "info") {
    const records: Array<{ event: string; data: Record<string, any>; level: string }> = []
    const logger = new Logger(false, level)
    logger.diagnostic = async (event, data, severity = "info") => {
        records.push({ event, data, level: severity })
    }
    return { logger, records }
}

test("one completion with exclusive stages; finish is idempotent", async () => {
    const { logger, records } = capture()
    let request!: ContextDiagnostic
    const result = await diagnoseContext(logger, "session", async (diagnostic) => {
        request = diagnostic!
        assert.equal(currentDiagnostic(), request)
        const parent = request.timeline("context", "fetch")
        await setImmediate()
        parent.next("transform")
        const child = request.timeline("transform", "filters")
        await setImmediate()
        child.next("tokens")
        child.end()
        parent.next("convert")
        return 42
    })
    request.finish()
    assert.equal(result, 42)
    assert.equal(currentDiagnostic(), undefined)
    assert.equal(records.length, 1)
    const record = records[0].data
    assert.equal(record.status, "ok")
    assert.equal(record.schemaVersion, 1)
    assert.ok(record.totalMs >= 0)
    assert.ok(
        Math.abs(
            Object.values<number>(record.stageMs.context).reduce((a, b) => a + b, 0) -
                record.totalMs,
        ) < 5,
    )
    assert.deepEqual(Object.keys(record.stageMs.transform), ["filters", "tokens"])
    assert.equal(record.tokens, undefined, "uncollected counters must not masquerade as zero")
})

test("async concurrent requests and late continuations are isolated", async () => {
    const { logger, records } = capture()
    const late: Array<() => unknown> = []
    await Promise.all(
        ["a", "b"].map((session) =>
            diagnoseContext(logger, session, async (request) => {
                assert.equal(currentDiagnostic(), request)
                await setImmediate()
                assert.equal(currentDiagnostic()?.sessionId, session)
                request!.counts.inputMessages = session === "a" ? 1 : 2
                late.push(() => request!.active)
            }),
        ),
    )
    assert.equal(new Set(records.map((record) => record.data.traceId)).size, 2)
    assert.equal(
        records.find((record) => record.data.sessionId === "a")!.data.counts.inputMessages,
        1,
    )
    assert.equal(
        records.find((record) => record.data.sessionId === "b")!.data.counts.inputMessages,
        2,
    )
    assert.ok(late.every((callback) => callback() === false))
})

test("skips and errors retain the original result and deepest failure stage", async () => {
    const { logger, records } = capture()
    for (const reason of ["empty_history", "internal_agent", "subagent_disabled"] as const) {
        await diagnoseContext(logger, reason, async (request) => request!.skip(reason))
        assert.equal(records.at(-1)!.data.status, "skipped")
        assert.equal(records.at(-1)!.data.skipReason, reason)
    }
    const original = new Error("sensitive request detail")
    await assert.rejects(
        diagnoseContext(logger, "failure", async (request) => {
            request!.timeline("context", "transform")
            request!.timeline("transform", "tokens")
            request!.fail("transform")
            throw original
        }),
        (error) => error === original,
    )
    const failed = records.at(-1)!
    assert.equal(failed.level, "error")
    assert.equal(failed.data.failedStage, "transform.tokens")
    assert.ok(!JSON.stringify(failed).includes(original.message))
})

test("silent runs without a diagnostic scope; logging failure does not replace errors", async () => {
    const { logger, records } = capture("silent")
    await diagnoseContext(logger, "silent", async (request) => assert.equal(request, undefined))
    assert.equal(records.length, 0)
    const broken = capture().logger
    broken.diagnostic = () => {
        throw new Error("sink failed")
    }
    assert.equal(await diagnoseContext(broken, "broken", async () => "result"), "result")
    const original = new Error("original")
    await assert.rejects(
        diagnoseContext(broken, "broken", async () => {
            throw original
        }),
        (error) => error === original,
    )
})

test("daily sink preserves JSON, level filtering, ordinary formatting and call-time timestamps", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-diagnostics-test-"))
    const before = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = sandbox
    try {
        const daily = join(sandbox, "opencode/logs/acp/daily")
        await mkdir(daily, { recursive: true })
        const payload = {
            schemaVersion: 1,
            stageMs: { transform: { longStageName: 123.456 } },
            text: "synthetic | fixture\nvalue",
        }
        for (const level of ["info", "warn", "error", "silent"] as const) {
            const logger = new Logger(false, level)
            await logger.diagnostic("context", { ...payload, level }, "info")
            await logger.diagnostic("context", { ...payload, level, failure: true }, "error")
        }
        const logger = new Logger(false, "info")
        await logger.info("ordinary", { size: 3 })
        const pending = logger.diagnostic("context", { ...payload, timestampProbe: true })
        const invokedAt = Date.now()
        const until = performance.now() + 30
        while (performance.now() < until) {}
        await pending
        const log = (
            await Promise.all(
                (await readdir(daily)).map((file) => readFile(join(daily, file), "utf8")),
            )
        ).join("")
        const diagnostics = log
            .trim()
            .split("\n")
            .filter((line) => line.includes("diagnostics: context |"))
        assert.equal(diagnostics.length, 5)
        const parsed = diagnostics.map((line) =>
            JSON.parse(line.slice(line.indexOf(" | ") + 3, line.lastIndexOf(" | v="))),
        )
        assert.deepEqual(parsed[0].stageMs, payload.stageMs)
        assert.equal(parsed[0].text, payload.text)
        assert.ok(parsed.every((record) => typeof record.version === "string"))
        assert.ok(log.includes("ordinary | size=3 | v="))
        const probe = diagnostics.find((line) => line.includes('"timestampProbe":true'))!
        assert.ok(Date.parse(probe.split(" ")[0]) <= invokedAt)
        assert.equal((await readdir(join(sandbox, "opencode/logs/acp"))).includes("context"), false)
    } finally {
        if (before === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = before
        await rm(sandbox, { recursive: true, force: true })
    }
})
