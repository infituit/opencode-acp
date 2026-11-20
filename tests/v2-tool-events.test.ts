import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpV2Plugin } from "../src/v2/plugin"
import { SessionStateRegistry } from "../src/state"

type ToolEvent = {
    type: string
    created: number
    data: { sessionID: string; assistantMessageID: string; id: string; name?: string }
}

function event(
    type: string,
    name?: string,
    sessionID = "session",
    assistantMessageID = "message",
    id = "call",
    created = 100,
): ToolEvent {
    return { type, created, data: { sessionID, assistantMessageID, id, name } }
}

function assistant(id = "message", name = "read", callID = "call") {
    return { id, type: "assistant", content: [{ type: "tool", id: callID, name }] }
}

type Entry = ToolEvent | (() => void | Promise<void>)

async function fixture(
    t: TestContext,
    entries: Entry[],
    context: (sessionID: string, attempt: number) => unknown = () => [assistant()],
) {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-v2-tool-events-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    await writeFile(
        join(sandbox, "acp.json"),
        JSON.stringify({ autoUpdate: false, logLevel: "silent" }),
    )
    let registry: SessionStateRegistry | undefined
    t.mock.method(
        SessionStateRegistry.prototype,
        "hydrateModelLimitsFromClient",
        async function (this: SessionStateRegistry) {
            registry = this
        },
    )
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    let start!: () => void
    const ready = new Promise<void>((resolve) => (start = resolve))
    const reads: string[] = []
    let signal: AbortSignal | undefined
    const storage = new Map<string, unknown>()
    const ctx = {
        location: { directory: sandbox },
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => storage.set(key, value),
            scan: async () => [],
        },
        session: {
            context: async ({ sessionID }: { sessionID: string }) => {
                reads.push(sessionID)
                return context(sessionID, reads.length)
            },
            hook: async () => {},
        },
        tool: { transform: async () => {} },
        command: { transform: async () => {} },
        event: {
            subscribe: async function* (options: { signal: AbortSignal }) {
                signal = options.signal
                try {
                    await ready
                    for (const entry of entries) {
                        if (signal.aborted) break
                        if (typeof entry === "function") await entry()
                        else yield entry
                    }
                } finally {
                    finish()
                }
            },
        },
    }
    let dispose: (() => void) | undefined
    t.after(async () => {
        dispose?.()
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key]
            else process.env[key] = previous[index]
        })
        await rm(sandbox, { recursive: true, force: true })
    })
    dispose = (await AcpV2Plugin.setup(ctx as never)) as typeof dispose
    assert.ok(registry)
    return { done, reads, registry, start, dispose: () => dispose?.(), signal: () => signal }
}

test("observed ordinary tool lifecycles never read history", async (t) => {
    const run = await fixture(t, [
        event("session.tool.input.started", "read"),
        event("session.tool.called"),
        event("session.tool.success"),
        event("session.tool.input.started", "write"),
        event("session.tool.failed"),
    ])
    run.start()
    await run.done
    assert.deepEqual(run.reads, [])
})

test("a successful ordinary fallback is reused until its terminal event", async (t) => {
    const run = await fixture(t, [event("session.tool.called"), event("session.tool.success")])
    run.start()
    await run.done
    assert.deepEqual(run.reads, ["session"])
})

test("an undefined lookup is retried at the terminal event", async (t) => {
    const run = await fixture(
        t,
        [event("session.tool.called"), event("session.tool.success")],
        (_sessionID, attempt) => (attempt === 1 ? [] : [assistant()]),
    )
    run.start()
    await run.done
    assert.equal(run.reads.length, 2)
})

test("a lookup error remains retryable and does not stop later consumption", async (t) => {
    const run = await fixture(
        t,
        [
            event("session.tool.called"),
            event("session.tool.success"),
            event("session.tool.input.started", "write", "later"),
            event("session.tool.called", undefined, "later"),
            event("session.tool.success", undefined, "later"),
        ],
        (_sessionID, attempt) => {
            if (attempt === 1) throw new Error("history temporarily unavailable")
            return [assistant()]
        },
    )
    run.start()
    await run.done
    assert.deepEqual(run.reads, ["session", "session"])
})

test("names are isolated across sessions and assistant steps", async (t) => {
    let run: Awaited<ReturnType<typeof fixture>>
    run = await fixture(t, [
        event("session.tool.input.started", "acp_compress"),
        event("session.tool.input.started", "read", "other"),
        event("session.tool.input.started", "write", "session", "other-message"),
        event("session.tool.called", undefined, "other"),
        event("session.tool.called", undefined, "session", "other-message"),
        event("session.tool.called"),
        () => {
            assert.deepEqual(
                [...run.registry.compressionTiming.startsByCallId.keys()],
                ["message:call"],
            )
        },
        event("session.tool.success", undefined, "session", "message", "call", 700),
    ])
    run.start()
    await run.done
    assert.deepEqual(run.reads, [])
    assert.equal(
        run.registry.compressionTiming.pendingByCallId.get("message:call")?.durationMs,
        600,
    )
})

test("fallback searches only the exact assistant message", async (t) => {
    const run = await fixture(
        t,
        [event("session.tool.called"), event("session.tool.success")],
        () => [assistant("old", "acp_compress"), assistant()],
    )
    run.start()
    await run.done
    assert.equal(run.reads.length, 1)
    assert.equal(run.registry.compressionTiming.pendingByCallId.size, 0)
    assert.equal(run.registry.compressionTiming.startsByCallId.size, 0)
})

test("success and failure evict ordinary and compression names", async (t) => {
    const entries: Entry[] = []
    for (const name of ["read", "acp_compress"]) {
        for (const terminal of ["session.tool.success", "session.tool.failed"]) {
            entries.push(
                event("session.tool.input.started", name),
                event(terminal),
                event("session.tool.called"),
                event("session.tool.failed"),
            )
        }
    }
    const run = await fixture(t, entries)
    run.start()
    await run.done
    assert.equal(run.reads.length, 4)
})

test("idle and deletion clear only the matching session names", async (t) => {
    const entries: Entry[] = []
    for (const type of ["session.idle", "session.deleted"]) {
        entries.push(
            event("session.tool.input.started", "read"),
            event("session.tool.input.started", "write", "other"),
            event(type),
            event("session.tool.called"),
            event("session.tool.called", undefined, "other"),
            event("session.tool.failed"),
            event("session.tool.failed", undefined, "other"),
        )
    }
    const run = await fixture(t, entries)
    run.start()
    await run.done
    assert.deepEqual(run.reads, ["session", "session"])
})

test("the 4096 entry cache evicts its oldest name and retains fallback", async (t) => {
    const entries: Entry[] = []
    for (let index = 0; index <= 4096; index++) {
        entries.push(
            event("session.tool.input.started", "read", "session", "message", `call-${index}`),
        )
    }
    entries.push(
        event("session.tool.called", undefined, "session", "message", "call-1"),
        event("session.tool.called", undefined, "session", "message", "call-4096"),
        event("session.tool.called", undefined, "session", "message", "call-0"),
        event("session.tool.failed", undefined, "session", "message", "call-0"),
    )
    const run = await fixture(t, entries, () => [assistant("message", "read", "call-0")])
    run.start()
    await run.done
    assert.equal(run.reads.length, 1)
})

test("input start does not start timing and called timestamps remain authoritative", async (t) => {
    let run: Awaited<ReturnType<typeof fixture>>
    run = await fixture(t, [
        event("session.tool.input.started", "acp_compress", "session", "message", "call", 10),
        () => assert.equal(run.registry.compressionTiming.startsByCallId.size, 0),
        event("session.tool.called", undefined, "session", "message", "call", 100),
        event("session.tool.called", undefined, "session", "message", "call", 150),
        event("session.tool.success", undefined, "session", "message", "call", 900),
        event("session.tool.input.started", "acp_compress", "session", "failed-message"),
        event("session.tool.called", undefined, "session", "failed-message"),
        event("session.tool.failed", undefined, "session", "failed-message"),
    ])
    run.start()
    await run.done
    assert.deepEqual(run.reads, [])
    assert.equal(run.registry.compressionTiming.startsByCallId.size, 0)
    assert.equal(
        run.registry.compressionTiming.pendingByCallId.get("message:call")?.durationMs,
        800,
    )
    assert.equal(run.registry.compressionTiming.pendingByCallId.has("failed-message:call"), false)
})

test("unload aborts the subscription before any further events are consumed", async (t) => {
    let reached!: () => void
    const paused = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const resume = new Promise<void>((resolve) => (release = resolve))
    const run = await fixture(t, [
        event("session.tool.input.started", "read"),
        async () => {
            reached()
            await resume
        },
        event("session.tool.called"),
    ])
    run.start()
    await paused
    run.dispose()
    assert.equal(run.signal()?.aborted, true)
    release()
    await run.done
    assert.deepEqual(run.reads, [])
})

test("unload during a fallback does not forward a late compression event", async (t) => {
    let reached!: () => void
    const entered = new Promise<void>((resolve) => (reached = resolve))
    let release!: (value: ReturnType<typeof assistant>[]) => void
    const history = new Promise<ReturnType<typeof assistant>[]>((resolve) => (release = resolve))
    const run = await fixture(t, [event("session.tool.called")], () => {
        reached()
        return history
    })
    run.start()
    await entered
    run.dispose()
    release([assistant("message", "acp_compress")])
    await run.done
    assert.equal(run.signal()?.aborted, true)
    assert.equal(run.registry.compressionTiming.startsByCallId.size, 0)
})
