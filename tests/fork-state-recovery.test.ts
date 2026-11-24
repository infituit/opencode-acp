import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { createSessionState, ensureSessionInitialized } from "../src/state"
import {
    configureNativeStateStorage,
    loadSessionState,
    saveSessionState,
} from "../src/state/persistence"
import { rebuildCompressionState } from "../src/state/rebuild"
import { getSessionParentId, getSessionRelations, isSubAgentSession } from "../src/state/utils"
import { fromV2SessionMessages } from "../src/v2/messages"
import { prune } from "../src/messages/prune"

async function fixture(t: TestContext, customStorage = false) {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-fork-recovery-"))
    const storage = new Map<string, unknown>()
    const nativeReads: string[] = []
    configureNativeStateStorage({
        get: async (key) => {
            nativeReads.push(key)
            return structuredClone(storage.get(key))
        },
        set: async (key, value) => {
            storage.set(key, structuredClone(value))
        },
    })
    t.after(async () => {
        configureNativeStateStorage(undefined)
        await rm(sandbox, { recursive: true, force: true })
    })
    const logger = new Logger(false, "silent")
    const config = getConfig({ directory: sandbox })
    config.storagePath = customStorage ? "state" : undefined
    config.compress.protectedTools = ["acp_compress"]
    config.protectedFilePatterns = []
    config.compress.minCompressRange = 0
    config.compress.preserveLastUserMessage = false
    config.compress.preserveRecentMessages = 0
    config.compress.preserveRecentTokens = 0
    const history = [
        { id: "source-prompt", type: "user", text: "Inspect the project." },
        { id: "source-old", type: "assistant", content: [{ type: "text", text: "OLD_CONTENT" }] },
        {
            id: "source-compress",
            type: "assistant",
            content: [
                {
                    type: "tool",
                    id: "source-call",
                    name: "acp_compress",
                    state: {
                        status: "completed",
                        input: {
                            content: [
                                { startId: "m00002", endId: "m00002", summary: "Saved summary." },
                            ],
                        },
                        output: "Compressed.",
                    },
                },
            ],
        },
    ]
    const source = createSessionState()
    source.sessionId = "source"
    source.storageDir = customStorage ? join(sandbox, "state") : undefined
    assert.equal(
        rebuildCompressionState(source, fromV2SessionMessages(history, "source"), config, logger),
        1,
    )
    await saveSessionState(source, logger)
    const forkHistory = structuredClone(history)
    for (const message of forkHistory) {
        message.id = message.id.replace("source-", "fork-")
        for (const part of message.content ?? []) {
            if (part.type === "tool") {
                const tool = part as { id: string; state: { input?: unknown } }
                tool.id = "fork-call"
                delete tool.state.input
            }
        }
    }
    const requests: string[] = []
    let metadata: any = {
        fork: { sessionID: "source", boundary: { type: "through", messageID: "source-compress" } },
    }
    const client = {
        session: {
            get: async () => metadata,
            context: async ({ sessionID }: { sessionID: string }) => {
                requests.push(sessionID)
                return history
            },
        },
    }
    const initialize = async (input = forkHistory) => {
        const state = createSessionState()
        await ensureSessionInitialized(
            client,
            state,
            "fork",
            logger,
            fromV2SessionMessages(input, "fork"),
            config,
            sandbox,
        )
        return state
    }
    return {
        sandbox,
        source,
        history,
        forkHistory,
        requests,
        nativeReads,
        config,
        logger,
        initialize,
        setMetadata: (value: any) => {
            metadata = value
        },
    }
}

for (const customStorage of [false, true]) {
    test(`fresh fork restores translated blocks without becoming a subagent (${customStorage ? "custom storage" : "native storage"})`, async (t) => {
        const f = await fixture(t, customStorage)
        const state = await f.initialize()
        assert.equal(state.isSubAgent, false)
        assert.deepEqual(f.requests, ["source"])
        assert.deepEqual(state.prune.messages.blocksById.get(1)?.effectiveMessageIds, ["fork-old"])
        assert.equal(state.prune.messages.blocksById.get(1)?.compressCallId, "fork-call")
        assert.equal(state.messageIds.byRawId.get("fork-prompt"), "m00001")
        const visible = fromV2SessionMessages(f.forkHistory, "fork")
        prune(state, f.logger, f.config, visible)
        assert.equal(
            visible.some((message) => message.info.id === "fork-old"),
            false,
        )
        assert.equal(
            visible.some((message) => message.info.id === "fork-prompt"),
            true,
        )
        assert.equal(
            (await loadSessionState("fork", f.logger, state.storageDir))?.prune.messages
                ?.activeBlockIds.length,
            1,
        )
        if (customStorage) assert.deepEqual(f.nativeReads, [])
    })
}

for (const type of ["before", "through"] as const) {
    test(`fork respects the ${type} boundary`, async (t) => {
        const f = await fixture(t)
        // An identical-looking message beyond the fork point must not authorize transfer.
        f.setMetadata({
            fork: { sessionID: "source", boundary: { type, messageID: "source-compress" } },
        })
        const state = await f.initialize()
        assert.equal(state.prune.messages.blocksById.size, type === "through" ? 1 : 0)
    })
}

test("before boundary restores blocks wholly contained in the copied prefix", async (t) => {
    const f = await fixture(t)
    f.history.push({ id: "source-next", type: "user", text: "Continue later." })
    f.setMetadata({
        fork: { sessionID: "source", boundary: { type: "before", messageID: "source-next" } },
    })
    const state = await f.initialize()
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.messageIds.byRawId.has("source-next"), false)
})

test("missing fork boundary fails closed without guessing aliases", async (t) => {
    const f = await fixture(t)
    f.setMetadata({
        fork: { sessionID: "source", boundary: { type: "through", messageID: "missing" } },
    })
    const state = await f.initialize()
    assert.equal(state.prune.messages.blocksById.size, 0)
})

test("fork source takes precedence over the independent subagent parent", async (t) => {
    const f = await fixture(t)
    f.setMetadata({
        parentID: "subagent-parent",
        fork: { sessionID: "source", boundary: { type: "through", messageID: "source-compress" } },
    })
    const state = await f.initialize()
    assert.equal(state.isSubAgent, true)
    assert.deepEqual(f.requests, ["source"])
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("parent-only sessions retain their existing subagent and transfer behavior", async (t) => {
    const f = await fixture(t)
    f.setMetadata({ parentID: "source" })
    const state = await f.initialize()
    assert.equal(state.isSubAgent, true)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("unavailable fork source falls back to replayable local history", async (t) => {
    const f = await fixture(t)
    f.setMetadata({
        fork: {
            sessionID: "unavailable",
            boundary: { type: "through", messageID: "source-compress" },
        },
    })
    const state = await f.initialize(
        f.history.map((message) => ({ ...message, id: message.id.replace("source-", "fork-") })),
    )
    assert.equal(state.isSubAgent, false)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.deepEqual(f.requests, [])
})

test("existing empty fork state is not overwritten by source recovery", async (t) => {
    const f = await fixture(t)
    const empty = createSessionState()
    empty.sessionId = "fork"
    await saveSessionState(empty, f.logger)
    const state = await f.initialize()
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.deepEqual(f.requests, [])
})

test("fork translates only verified sticky call IDs and persists them across restart", async (t) => {
    const f = await fixture(t)
    f.source.stickyTruncations = {
        "source-call": "Frozen output",
        "outside-call": "Outside boundary",
    }
    await saveSessionState(f.source, f.logger)
    const state = await f.initialize()
    assert.deepEqual(state.stickyTruncations, { "fork-call": "Frozen output" })
    const restarted = await f.initialize()
    assert.deepEqual(restarted.stickyTruncations, state.stickyTruncations)
    assert.equal(restarted.prune.messages.blocksById.size, 1)
    assert.deepEqual(f.requests, ["source"])
})

test("fork mapping failure inherits neither compression blocks nor frozen outputs", async (t) => {
    const f = await fixture(t)
    f.source.stickyTruncations = { "source-call": "Frozen output" }
    await saveSessionState(f.source, f.logger)
    const changed = structuredClone(f.forkHistory)
    changed[1]!.content = [{ type: "text", text: "Different history" }]
    const state = await f.initialize(changed)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.deepEqual(state.stickyTruncations, {})
})

test("source advancement beyond the fork boundary does not partially transfer active blocks", async (t) => {
    const f = await fixture(t)
    const advanced = structuredClone(f.history)
    const later = structuredClone(advanced[2]!)
    later.id = "source-later"
    const tool = later.content![0] as any
    tool.id = "later-call"
    tool.state.input = {
        content: [{ startId: "m00001", endId: "m00001", summary: "Later summary" }],
    }
    advanced.push(later)
    assert.equal(
        rebuildCompressionState(
            f.source,
            fromV2SessionMessages(advanced, "source"),
            f.config,
            f.logger,
        ),
        2,
    )
    await saveSessionState(f.source, f.logger)
    const state = await f.initialize()
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.deepEqual(state.stickyTruncations, {})
})

test("session relations validate fork metadata while parent helpers retain parent-only semantics", async () => {
    for (const fork of [
        undefined,
        {},
        { sessionID: "source" },
        { sessionID: "fork", boundary: { type: "through", messageID: "x" } },
        { sessionID: "source", boundary: { type: "unknown", messageID: "x" } },
    ]) {
        const client = { session: { get: async () => ({ fork }) } }
        assert.equal((await getSessionRelations(client, "fork")).fork, undefined)
        assert.equal(await getSessionParentId(client, "fork"), undefined)
        assert.equal(await isSubAgentSession(client, "fork"), false)
    }
    assert.deepEqual(
        await getSessionRelations(
            {
                session: {
                    get: async () => {
                        throw new Error("Unavailable")
                    },
                },
            },
            "fork",
        ),
        {},
    )
})
