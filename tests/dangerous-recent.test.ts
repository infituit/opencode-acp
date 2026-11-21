import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { getConfig } from "../src/config"
import { countMessageCharacters, estimateAllMessageTokensFast } from "../src/context-usage"
import { Logger } from "../src/logger"
import { assignMessageRefs } from "../src/message-ids"
import { prune } from "../src/messages/prune"
import { PromptStore } from "../src/prompts/store"
import { createSessionState, ensureSessionInitialized } from "../src/state"
import { configureNativeStateStorage } from "../src/state/persistence"
import { fromV2SessionMessages } from "../src/v2/messages"
import { createCompressRangeTool } from "../src/compress/range"
import { prepareExecutableRangePlans } from "../src/compress/range-utils"
import { buildSearchContext } from "../src/compress/search"
import { clearSmartPlanSession } from "../src/compress/smart-plan"
import type { CompressRangeToolArgs, ToolFactoryContext } from "../src/compress/types"

function assistant(id: string, text = id.repeat(40).slice(0, 40)) {
    return { id, type: "assistant", content: [{ type: "text", text }] }
}

async function fixture(
    t: TestContext,
    history: any[] = [assistant("old"), assistant("recent-a"), assistant("recent-b")],
) {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-dangerous-recent-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    const storage = new Map<string, unknown>()
    configureNativeStateStorage({
        get: async (key) => structuredClone(storage.get(key)),
        set: async (key, value) => {
            storage.set(key, structuredClone(value))
        },
    })
    const sessionID = "dangerous-recent"
    t.after(async () => {
        clearSmartPlanSession(sessionID)
        configureNativeStateStorage(undefined)
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key]
            else process.env[key] = previous[index]
        })
        await rm(sandbox, { recursive: true, force: true })
    })
    const logger = new Logger(false, "silent")
    const config = getConfig({ directory: sandbox })
    config.compress.images.enabled = false
    config.qualityGate.enabled = false
    config.compress.smartPlanRequired = false
    config.compress.minCompressRange = 0
    config.compress.lastSegmentSoftBlock = true
    config.compress.preserveLastUserMessage = true
    config.compress.preserveRecentMessages = 2
    config.compress.preserveRecentTokens = 0
    config.compress.protectedTools = []
    config.protectedFilePatterns = []
    const client = {
        session: {
            context: async () => history,
            get: async () => ({ id: sessionID }),
            synthetic: async () => {},
        },
    }
    const state = createSessionState()
    const messages = fromV2SessionMessages(history, sessionID)
    await ensureSessionInitialized(client, state, sessionID, logger, messages, config)
    assignMessageRefs(state, messages)
    const search = buildSearchContext(state, messages)
    const ref = (id: string) => state.messageIds.byRawId.get(id)!
    const entry = (start: string, end = start) => ({
        startId: ref(start),
        endId: ref(end),
        summary: "Recent investigation completed.",
    })
    const plan = (args: CompressRangeToolArgs) =>
        prepareExecutableRangePlans(args, search, state, config, logger)
    const tool = () =>
        createCompressRangeTool({
            client,
            registry: { get: () => state },
            logger,
            config,
            prompts: new PromptStore(logger, sandbox),
            assertPermission: async () => {},
        } as unknown as ToolFactoryContext)
    const toolContext = { sessionID, messageID: "current", id: "compress-call" }
    return { config, state, messages, entry, plan, tool, toolContext, storage, logger }
}

for (const mode of ["messages", "tokens"] as const) {
    test(`dangerous bypasses only explicitly opted-in recent ${mode} protection, including batches`, async (t) => {
        const f = await fixture(t)
        f.config.compress.preserveRecentMessages = mode === "messages" ? 2 : 0
        f.config.compress.preserveRecentTokens = mode === "tokens" ? 20 : 0
        const content = [f.entry("old", "recent-a"), f.entry("recent-b")]
        for (const dangerous of [undefined, false, true]) {
            const args = {
                topic: "Recent work",
                content,
                ...(dangerous === undefined ? {} : { dangerous }),
            }
            const result = f.plan(args)
            assert.deepEqual(
                result.plans.map((plan) => plan.selection.messageIds),
                dangerous === true ? [["old", "recent-a"], ["recent-b"]] : [["old"]],
            )
            assert.equal(result.totalChars, dangerous === true ? 120 : 40)
            const selected = result.plans.flatMap((plan) => [...plan.selection.messageTokenById])
            assert.deepEqual(
                selected,
                (dangerous === true ? ["old", "recent-a", "recent-b"] : ["old"]).map((id) => [
                    id,
                    10,
                ]),
            )
            if (dangerous !== true) {
                assert.throws(
                    () => f.plan({ ...args, content: [f.entry("recent-a", "recent-b")] }),
                    /All selected messages were filtered out/,
                )
            }
        }
    })
}

test("dangerous retains wildcard tool, V2 file path and last real user protection", async (t) => {
    const f = await fixture(t, [
        assistant("old"),
        {
            id: "protected-tool",
            type: "assistant",
            content: [
                { type: "tool", id: "lookup", name: "memory_lookup", input: {}, result: "secret" },
            ],
        },
        {
            id: "protected-file",
            type: "assistant",
            content: [
                {
                    type: "tool",
                    id: "read",
                    name: "read",
                    input: { path: "docs/AGENTS.md" },
                    result: "rules",
                },
            ],
        },
        { id: "human", type: "user", text: "Keep this real user request visible." },
        { id: "host", type: "synthetic", text: "Delivered worker report." },
        assistant("recent"),
    ])
    f.config.compress.protectedTools = ["memory_*"]
    f.config.protectedFilePatterns = ["**/AGENTS.md"]
    f.config.compress.preserveRecentMessages = 20
    const result = f.plan({ topic: "Mixed", content: [f.entry("old", "recent")], dangerous: true })
    const selection = result.plans[0]!.selection
    assert.deepEqual(selection.messageIds, ["old", "host", "recent"])
    assert.deepEqual(selection.toolIds, [])
    const remaining = f.messages.filter((message) => selection.messageIds.includes(message.info.id))
    assert.deepEqual(
        [...selection.messageTokenById],
        remaining.map((message) => [message.info.id, estimateAllMessageTokensFast(message)]),
    )
    assert.equal(
        result.totalChars,
        remaining.reduce((sum, message) => sum + countMessageCharacters(message), 0),
    )
    f.config.compress.minCompressRange = result.totalChars + 1
    assert.throws(
        () => f.plan({ topic: "Mixed", content: [f.entry("old", "recent")], dangerous: true }),
        /Range too small/,
    )
})

test("dangerous does not change ranges when recent protection is disabled", async (t) => {
    const f = await fixture(t)
    for (const softBlock of [true, false]) {
        f.config.compress.lastSegmentSoftBlock = softBlock
        f.config.compress.preserveRecentMessages = softBlock ? 0 : 20
        f.config.compress.preserveRecentTokens = softBlock ? 0 : 1000
        const args = { topic: "Unprotected", content: [f.entry("old", "recent-b")] }
        const baseline = f.plan(args)
        assert.deepEqual(baseline.plans[0]!.selection.messageIds, ["old", "recent-a", "recent-b"])
        for (const dangerous of [false, true])
            assert.deepEqual(f.plan({ ...args, dangerous }), baseline)
    }
})

for (const dangerous of [undefined, false, true]) {
    test(`compress tool ${String(dangerous)} ${dangerous ? "folds" : "preserves"} a recent message`, async (t) => {
        const f = await fixture(t, [
            { id: "prompt", type: "user", text: "Investigate the failure." },
            assistant("old"),
            assistant("recent", "ORIGINAL_RECENT_PAYLOAD ".repeat(100)),
            { id: "current", type: "assistant", content: [] },
        ])
        const args = {
            topic: "Recent work",
            content: [f.entry("recent")],
            ...(dangerous === undefined ? {} : { dangerous }),
        }
        const before = structuredClone(f.state.prune)
        const execute = () => f.tool().execute(args as never, f.toolContext as never)
        if (dangerous === true) {
            const result = await execute()
            assert.match(JSON.stringify(result), /Compressed 1 messages/)
            const block = [...f.state.prune.messages.blocksById.values()][0]!
            assert.deepEqual(block.directMessageIds, ["recent"])
            assert.deepEqual(block.effectiveMessageIds, ["recent"])
            assert.equal(block.active, true)
            assert.ok(f.storage.size > 0)
        } else {
            await assert.rejects(execute, /All selected messages were filtered out/)
            assert.deepEqual(f.state.prune, before)
            assert.equal(f.storage.size, 0)
        }
        prune(f.state, f.logger, f.config, f.messages)
        assert.equal(
            f.messages.some((message) => message.info.id === "recent"),
            dangerous !== true,
        )
        assert.equal(
            JSON.stringify(f.messages).includes("ORIGINAL_RECENT_PAYLOAD"),
            dangerous !== true,
        )
    })
}

test("dangerous still runs the pre-commit quality gate", async (t) => {
    const f = await fixture(t, [
        assistant("recent", "Important evidence and decisions. ".repeat(300)),
    ])
    f.config.qualityGate.enabled = true
    const before = structuredClone(f.state.prune)
    await assert.rejects(
        () =>
            f.tool().execute(
                {
                    topic: "Recent work",
                    content: [{ ...f.entry("recent"), summary: "x" }],
                    dangerous: true,
                } as never,
                f.toolContext as never,
            ),
        /COMPRESSION REJECTED — QUALITY GATE FAILURE/,
    )
    assert.deepEqual(f.state.prune, before)
    assert.equal(f.state.qualityGateRetryPending, true)
    assert.equal(f.storage.size, 0)
})

test("dangerous cannot bypass the required smart plan or mutate compression state on rejection", async (t) => {
    const f = await fixture(t)
    f.config.compress.smartPlanRequired = true
    clearSmartPlanSession(f.toolContext.sessionID)
    const before = structuredClone({ prune: f.state.prune, stats: f.state.stats })
    await assert.rejects(
        () =>
            f.tool().execute(
                {
                    topic: "Recent work",
                    content: [f.entry("recent-b")],
                    dangerous: true,
                } as never,
                f.toolContext as never,
            ),
        /No smart compression plan is armed/,
    )
    assert.deepEqual({ prune: f.state.prune, stats: f.state.stats }, before)
    assert.equal(f.storage.size, 0)
})
