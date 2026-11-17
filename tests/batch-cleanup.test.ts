import assert from "node:assert/strict"
import { test } from "node:test"
import { runBatchCleanup } from "../src/gc/merge"
import { createSessionState, type CompressionBlock } from "../src/state"
import { getCurrentTokenUsage } from "../src/context-usage"
import { fromV2SessionMessages } from "../src/v2/messages"
import type { PluginConfig } from "../src/config"
import { Logger } from "../src/logger"

test("batch cleanup reuses the pre-prune count without changing merge or budget behavior", (t) => {
    t.mock.method(Date, "now", () => 1000)
    const logger = new Logger(false, "silent")
    const config = {
        compress: { contextLimitFallback: 0 },
        gc: { maxOldGenSummaryLength: 1000 },
    } as PluginConfig
    const messages = fromV2SessionMessages(
        [{ id: "user", type: "user", text: "Large history. ".repeat(100), time: { created: 100 } }],
        "session",
    )
    const state = createSessionState()
    state.modelContextLimit = 1
    for (const id of [1, 2]) {
        const block: CompressionBlock = {
            blockId: id,
            runId: id,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 10,
            durationMs: 0,
            topic: `Block ${id}`,
            startId: `m${id}`,
            endId: `m${id}`,
            anchorMessageId: `message${id}`,
            compressMessageId: "",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            createdAt: 100,
            summary: `Summary ${id}`,
            survivedCount: 0,
            generation: "old",
        }
        state.prune.messages.blocksById.set(id, block)
        state.prune.messages.activeBlockIds.add(id)
    }
    state.prune.messages.nextBlockId = 3
    state.prune.messages.nextRunId = 3
    const counted = getCurrentTokenUsage(state, messages)
    const originalMessages = structuredClone(messages)
    const legacy = structuredClone(state)
    const shared = structuredClone(state)
    const unreadable = new Proxy(messages, {
        get() {
            assert.fail("a supplied projection count must not rescan history")
        },
    })
    const expected = runBatchCleanup(legacy, config, logger, messages)
    assert.equal(expected.mergedCount, 2)
    assert.deepEqual(runBatchCleanup(shared, config, logger, unreadable, counted), expected)
    assert.deepEqual(shared, legacy)
    assert.deepEqual(messages, originalMessages)
    assert.equal(getCurrentTokenUsage(shared, messages), counted)

    for (const limit of [counted - 1, counted, counted + 1]) {
        const expectedState = structuredClone(state)
        expectedState.modelContextLimit = limit
        const reusedState = structuredClone(expectedState)
        const result = runBatchCleanup(expectedState, config, logger, messages)
        assert.equal(result.action, limit <= counted ? "merge" : "none")
        assert.deepEqual(runBatchCleanup(reusedState, config, logger, unreadable, counted), result)
        assert.deepEqual(reusedState, expectedState)
    }

    const empty = structuredClone(state)
    assert.equal(runBatchCleanup(empty, config, logger, unreadable, 0).action, "none")
    assert.deepEqual(empty, state)
    const unlimited = structuredClone(state)
    unlimited.modelContextLimit = 0
    assert.equal(runBatchCleanup(unlimited, config, logger, unreadable).action, "none")
})
