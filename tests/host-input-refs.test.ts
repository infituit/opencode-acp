import assert from "node:assert/strict"
import { test } from "node:test"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { assignMessageRefs, repairNonMonotonicMessageRefs } from "../src/message-ids"
import { armBestSmartPlan, clearSmartPlanSession } from "../src/compress/smart-plan"
import { buildSearchContext } from "../src/compress/search"
import { createAcpStatusToolV2 } from "../src/compress/status"
import { PromptStore } from "../src/prompts/store"
import { createSessionState, type WithParts } from "../src/state"
import { rebuildCompressionState, restoreForkCompressionState } from "../src/state/rebuild"
import type { PersistedSessionState } from "../src/state/persistence"
import { serializePruneMessagesState } from "../src/state/utils"
import { fromV2SessionMessages } from "../src/v2/messages"

const logger = new Logger(false, "silent")
logger.info = logger.warn = logger.debug = () => undefined
const config = getConfig({ directory: process.cwd() })
config.compress.protectedTools = ["acp_compress"]
config.protectedFilePatterns = []
config.compress.minCompressRange = 0
config.compress.preserveLastUserMessage = false
config.compress.preserveRecentMessages = 0
config.compress.preserveRecentTokens = 0

function message(id: string, host = false, role = "assistant"): WithParts {
    return fromV2SessionMessages(
        [
            {
                id,
                type: host ? "synthetic" : role,
                text: `Content for ${id}.`,
                content: [{ type: "text", text: `Content for ${id}.` }],
            },
        ],
        "refs-session",
    )[0]!
}

function invocation(id: string, startId: string, endId: string, marked = false): WithParts {
    const result = message(id)
    result.parts = [
        {
            type: "tool",
            tool: "acp_compress",
            callID: `call-${id}`,
            state: {
                status: "completed",
                input: { content: [{ startId, endId, summary: `Summary for ${id}.` }] },
                metadata: marked ? { acpHostInputRefs: true } : {},
            },
        },
    ]
    return result
}

function persist(state: ReturnType<typeof createSessionState>): PersistedSessionState {
    return {
        prune: { messages: serializePruneMessagesState(state.prune.messages) },
        messageIds: {
            byRawId: Object.fromEntries(state.messageIds.byRawId),
            byRef: Object.fromEntries(state.messageIds.byRef),
            nextRef: state.messageIds.nextRef,
        },
        nudges: { contextLimitAnchors: [] },
        stats: state.stats,
        lastUpdated: new Date().toISOString(),
    }
}

test("backfilled host refs retain historical aliases without triggering repair", () => {
    const state = createSessionState()
    const first = message("first")
    const host = message("host", true)
    const last = message("last")
    assignMessageRefs(state, [first, last])
    assignMessageRefs(state, [first, host, last])
    assert.deepEqual(
        [first, host, last].map((item) => state.messageIds.byRawId.get(item.info.id)),
        ["m00001", "m00003", "m00002"],
    )
    assert.equal(repairNonMonotonicMessageRefs(state, [first, host, last]), false)
    assert.equal(state.messageIds.byRawId.get("host"), "m00003")
})

test("a real nonhost alias corruption repair retains hosts and missing-history aliases", () => {
    const state = createSessionState()
    const messages = [message("first"), message("host", true), message("last")]
    assignMessageRefs(state, [messages[2]!, messages[1]!, messages[0]!, message("missing")])
    assert.equal(repairNonMonotonicMessageRefs(state, messages), true)
    assert.deepEqual([...state.messageIds.byRawId.keys()], ["first", "host", "last", "missing"])
    assert.equal(state.messageIds.byRef.get("m00002"), "host")
})

test("subagents skip their first real prompt, not an earlier host delivery", () => {
    const state = createSessionState()
    state.isSubAgent = true
    const messages = [message("host", true), message("prompt", false, "user"), message("answer")]
    assignMessageRefs(state, messages)
    assert.equal(state.messageIds.byRawId.has("prompt"), false)
    assert.equal(state.messageIds.byRawId.get("host"), "m00001")
    assert.equal(state.messageIds.byRawId.get("answer"), "m00002")
})

test("legacy replay uses nonhost aliases and never adds host membership", () => {
    const state = createSessionState()
    const messages = [
        message("first"),
        message("host", true),
        message("last"),
        invocation("compress", "m00001", "m00002"),
    ]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 1)
    assert.deepEqual(state.prune.messages.blocksById.get(1)?.effectiveMessageIds, ["first", "last"])
    assert.equal(state.prune.messages.byMessageId.has("host"), false)
    assert.equal(state.messageIds.byRawId.get("host"), "m00004")
    assert.equal(state.messageIds.byRawId.get("last"), "m00002")
})

test("fresh histories without compression receive chronological host aliases", () => {
    const state = createSessionState()
    const messages = [message("first"), message("host", true), message("last")]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 0)
    assert.deepEqual(
        messages.map((item) => state.messageIds.byRawId.get(item.info.id)),
        ["m00001", "m00002", "m00003"],
    )
})

test("marked replay with host history stops without preexisting aliases", () => {
    const state = createSessionState()
    const messages = [
        message("first"),
        message("host", true),
        invocation("marked", "m00001", "m00002", true),
        invocation("later", "m00001", "m00001"),
    ]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 0)
    assert.equal(state.prune.messages.byMessageId.size, 0)
})

test("aliases allocated during legacy replay do not authorize a later marked invocation", () => {
    const state = createSessionState()
    const messages = [
        message("first"),
        message("host", true),
        message("second"),
        invocation("legacy", "m00001", "m00001"),
        invocation("marked", "m00002", "m00002", true),
    ]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 1)
    assert.equal(state.prune.messages.byMessageId.has("second"), false)
    assert.equal(state.prune.messages.byMessageId.has("host"), false)
})

test("block-only marked calls also stop when host aliases cannot be recovered", () => {
    const state = createSessionState()
    const messages = [
        message("first"),
        message("host", true),
        invocation("legacy", "m00001", "m00001"),
        invocation("marked", "b1", "b1", true),
    ]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 1)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.prune.messages.blocksById.get(1)?.active, true)
})

test("marked replay honors existing host aliases, including nonmonotonic backfills", () => {
    const state = createSessionState()
    const first = message("first")
    const last = message("last")
    const host = message("host", true)
    assignMessageRefs(state, [first, last])
    assignMessageRefs(state, [first, host, last])
    const messages = [first, host, last, invocation("marked", "m00003", "m00002", true)]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 1)
    assert.deepEqual(state.prune.messages.blocksById.get(1)?.effectiveMessageIds, ["host", "last"])
    assert.equal(state.messageIds.byRawId.get("last"), "m00002")
})

test("marked calls without host history can safely replay sequential refs", () => {
    const state = createSessionState()
    const messages = [message("first"), invocation("marked", "m00001", "m00001", true)]
    assert.equal(rebuildCompressionState(state, messages, config, logger), 1)
    assert.deepEqual(state.prune.messages.blocksById.get(1)?.effectiveMessageIds, ["first"])
})

test("failed parent transfer leaves no locally guessed aliases for marked replay", () => {
    const parentState = createSessionState()
    const parentMessages = [message("first"), message("host", true), message("last")]
    assignMessageRefs(parentState, parentMessages)
    const parent = persist(parentState)
    const forkState = createSessionState()
    const forkMessages = [message("fork-first"), message("fork-host", true), message("fork-last")]
    assert.equal(
        restoreForkCompressionState(forkState, forkMessages, parent, parentMessages, logger),
        0,
    )
    assert.equal(forkState.messageIds.byRawId.size, 0)
    forkMessages.push(invocation("marked", "m00001", "m00002", true))
    assert.equal(rebuildCompressionState(forkState, forkMessages, config, logger), 0)
})

test("legacy parent transfer preserves old aliases while appending fork host refs", () => {
    const parentState = createSessionState()
    const parentMessages = [
        message("parent-first"),
        message("parent-host", true),
        message("parent-last"),
        invocation("parent-compress", "m00001", "m00002"),
    ]
    assert.equal(rebuildCompressionState(parentState, parentMessages, config, logger), 1)
    // This parent predates host refs, even though current conversion exposes hosts.
    const hostRef = parentState.messageIds.byRawId.get("parent-host")!
    parentState.messageIds.byRawId.delete("parent-host")
    parentState.messageIds.byRef.delete(hostRef)
    const forkState = createSessionState()
    const forkMessages = structuredClone(parentMessages)
    for (const item of forkMessages) {
        item.info.id = item.info.id.replace("parent-", "fork-")
        for (const part of item.parts) {
            if (part.type === "tool") part.callID = `call-${item.info.id}`
        }
    }
    assert.equal(
        restoreForkCompressionState(
            forkState,
            forkMessages,
            persist(parentState),
            parentMessages,
            logger,
        ),
        1,
    )
    assert.deepEqual(forkState.prune.messages.blocksById.get(1)?.effectiveMessageIds, [
        "fork-first",
        "fork-last",
    ])
    assert.equal(forkState.messageIds.byRawId.get("fork-last"), "m00002")
    assert.equal(forkState.messageIds.byRawId.get("fork-host"), "m00004")
})

test("failed legacy parent transfer does not seed aliases and legacy replay still succeeds", () => {
    const parentState = createSessionState()
    const parentMessages = [message("parent-first"), message("parent-last")]
    assignMessageRefs(parentState, parentMessages)
    const parent = persist(parentState)
    const forkState = createSessionState()
    const forkMessages = [message("fork-first"), message("fork-host", true), message("fork-last")]
    assert.equal(
        restoreForkCompressionState(forkState, forkMessages, parent, parentMessages, logger),
        0,
    )
    assert.equal(forkState.messageIds.byRawId.size, 0)
    forkMessages.push(invocation("legacy", "m00001", "m00002"))
    assert.equal(rebuildCompressionState(forkState, forkMessages, config, logger), 1)
    assert.deepEqual(forkState.prune.messages.blocksById.get(1)?.effectiveMessageIds, [
        "fork-first",
        "fork-last",
    ])
})

function range(ref: string) {
    return {
        startRef: ref,
        endRef: ref,
        count: 1,
        tokens: 5,
        effectiveTokens: 5,
        toolPct: 0,
        textPct: 100,
    }
}

test("smart plans merge transcript neighbors despite nonmonotonic host aliases", () => {
    const state = createSessionState()
    const messages = [message("first"), message("host", true), message("last")]
    assignMessageRefs(state, [messages[0]!, messages[2]!])
    assignMessageRefs(state, messages)
    const refs = messages.map((item) => state.messageIds.byRawId.get(item.info.id)!)
    try {
        const plan = armBestSmartPlan(
            "smart-host",
            refs.map(range),
            buildSearchContext(state, messages),
            { state, config, logger },
        )
        assert.deepEqual(plan?.messageIds, ["first", "host", "last"])
        assert.equal(plan?.startId, "m00001")
        assert.equal(plan?.endId, "m00002")
    } finally {
        clearSmartPlanSession("smart-host")
    }
})

test("smart plans do not cross a protected transcript gap with consecutive numeric refs", () => {
    const state = createSessionState()
    const messages = [message("first"), message("host", true), message("last")]
    assignMessageRefs(state, [messages[0]!, messages[2]!])
    assignMessageRefs(state, messages)
    try {
        const plan = armBestSmartPlan(
            "smart-gap",
            [range("m00001"), range("m00002")],
            buildSearchContext(state, messages),
            { state, config, logger },
        )
        assert.ok(plan)
        assert.equal(plan.messageIds.length, 1)
        assert.equal(plan.messageIds.includes("host"), false)
    } finally {
        clearSmartPlanSession("smart-gap")
    }
})

test("status excludes undelivered host inputs before assigning refs and advertising ranges", async () => {
    const state = createSessionState()
    state.visibleHostInputIds = new Set(["delivered"])
    const prompts = new PromptStore(logger, process.cwd())
    prompts.reload = () => undefined
    const tool = createAcpStatusToolV2({
        registry: { get: () => state },
        config,
        logger,
        prompts,
        client: {
            session: {
                context: async () => [
                    {
                        id: "answer",
                        type: "assistant",
                        content: [{ type: "text", text: "Answer" }],
                    },
                    { id: "delivered", type: "synthetic", text: "Delivered" },
                    { id: "late", type: "synthetic", text: "Late arrival" },
                ],
            },
        },
    } as never)
    const result = await tool.execute({ scope: "uncompressed", view: "messages" }, {
        sessionID: "refs-session",
    } as never)
    assert.equal(state.messageIds.byRawId.has("late"), false)
    assert.ok(state.messageIds.byRawId.has("delivered"))
    assert.match(JSON.stringify(result), /2 msgs/)
})
