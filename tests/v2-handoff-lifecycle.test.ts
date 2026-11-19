import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { PromptStore } from "../src/prompts/store"
import {
    createSessionState,
    ensureSessionInitialized,
    type SessionStateRegistry,
} from "../src/state"
import { configureNativeStateStorage } from "../src/state/persistence"
import { fromV2SessionMessages, toV2RequestMessages } from "../src/v2/messages"
import { createChatMessageTransformHandler } from "../src/v2/hooks"
import { createCompressRangeTool } from "../src/compress/range"
import { createDecompressTool } from "../src/compress/decompress"
import { filterUnseenHostInputs } from "../src/compress/pipeline"

for (const handoffOnly of [false, true]) {
    test(`handoffs survive compression, persisted restart and decompression without folding late arrivals (${handoffOnly ? "handoff-only" : "human history"})`, async () => {
        const sandbox = await mkdtemp(join(tmpdir(), "acp-handoff-lifecycle-"))
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
        try {
            const logger = new Logger(false, "silent")
            const config = getConfig({ directory: sandbox })
            config.compress.images.enabled = false
            config.qualityGate.enabled = false
            config.compress.smartPlanRequired = false
            config.compress.preserveRecentMessages = 0
            config.compress.preserveRecentTokens = 0
            const prompts = new PromptStore(logger, sandbox)
            const history: any[] = [
                { id: "prompt", type: "user", text: "Collect the worker result." },
                {
                    id: "launch",
                    type: "assistant",
                    content: [{ type: "text", text: "Worker started." }],
                },
                {
                    id: "delivery",
                    type: "synthetic",
                    text: "ORIGINAL_WORKER_RESULT ".repeat(300),
                    metadata: { source: "subagent" },
                },
                {
                    id: "seen",
                    type: "assistant",
                    content: [{ type: "text", text: "I have received the result." }],
                },
                { id: "followup", type: "user", text: "Now summarize the task." },
                { id: "current", type: "assistant", content: [] },
            ]
            if (handoffOnly) {
                for (let index = history.length - 1; index >= 0; index--) {
                    if (history[index].type === "user") history.splice(index, 1)
                }
            }
            const current = history.find((message) => message.id === "current")!
            const client = {
                session: {
                    context: async () => history,
                    get: async () => ({ id: "session" }),
                    synthetic: async () => {},
                },
            }
            let state = createSessionState()
            const registry = {
                get: () => state,
                async getOrCreate() {
                    await ensureSessionInitialized(
                        client,
                        state,
                        "session",
                        logger,
                        fromV2SessionMessages(history, "session"),
                        config,
                    )
                    return state
                },
                resolveModelLimit: () => 128000,
            } as unknown as SessionStateRegistry
            const factory = {
                client,
                registry,
                logger,
                config,
                prompts,
                assertPermission: async () => {},
            }
            const transform = createChatMessageTransformHandler(
                client,
                registry,
                logger,
                config,
                prompts,
                { global: undefined, agents: {} },
            )
            const project = async () => {
                const requestWindow = history
                    .filter((message) => message.id !== "late")
                    .map((message) => ({
                        id: message.id,
                        role: message.type === "synthetic" ? "user" : message.type,
                    }))
                const output = {
                    messages: fromV2SessionMessages(history, "session", requestWindow),
                }
                await transform({}, output)
                return JSON.stringify(toV2RequestMessages(output.messages))
            }
            assert.ok((await project()).includes("ORIGINAL_WORKER_RESULT"))
            state.visibleHostInputIds = new Set(["delivery"])
            const aliases = new Map(state.messageIds.byRawId)
            history.push({ id: "late", type: "synthetic", text: "UNSEEN_LATE_RESULT" })
            const eligible = filterUnseenHostInputs(
                state,
                fromV2SessionMessages(history, "session"),
            )
            assert.ok(!eligible.some((message) => message.info.id === "late"))
            const compress = createCompressRangeTool(factory)
            const ref = state.messageIds.byRawId.get("delivery")!
            assert.ok(ref)
            assert.ok(!state.messageIds.byRawId.has("late"))
            const result = await compress.execute(
                {
                    topic: "Worker",
                    content: [
                        { startId: ref, endId: ref, summary: "Worker completed successfully." },
                    ],
                    dangerous: true,
                } as never,
                { sessionID: "session", messageID: "current", id: "compress-call" } as never,
            )
            assert.equal(result.metadata?.acpHostInputRefs, true)
            const block = [...state.prune.messages.blocksById.values()][0]!
            assert.deepEqual(block.directMessageIds, ["delivery"])
            assert.ok(
                !block.summary.includes("ORIGINAL_WORKER_RESULT"),
                "delivery must not be appended as a protected human prompt",
            )
            current.content.push({
                type: "tool",
                id: "compress-call",
                name: "acp_compress",
                state: {
                    status: "completed",
                    input: {
                        content: [
                            { startId: ref, endId: ref, summary: "Worker completed successfully." },
                        ],
                    },
                    content: result.content,
                    metadata: result.metadata,
                },
            })
            // Native persistence must retain alias identity, but never request visibility.
            state = createSessionState()
            await ensureSessionInitialized(
                client,
                state,
                "session",
                logger,
                fromV2SessionMessages(history, "session"),
                config,
            )
            assert.equal(state.visibleHostInputIds, undefined)
            for (const [id, alias] of aliases) assert.equal(state.messageIds.byRawId.get(id), alias)
            assert.ok(!state.prune.messages.byMessageId.has("late"))
            const folded = await project()
            assert.ok(!folded.includes("ORIGINAL_WORKER_RESULT"))
            assert.ok(folded.includes("Worker completed successfully."))
            if (handoffOnly) assert.ok(folded.includes("Earlier host input has been compressed."))
            const decompress = createDecompressTool(factory)
            await decompress.execute(
                { blockId: `b${block.blockId}` } as never,
                { sessionID: "session", messageID: "current", id: "decompress-call" } as never,
            )
            assert.ok((await project()).includes("ORIGINAL_WORKER_RESULT"))
        } finally {
            configureNativeStateStorage(undefined)
            keys.forEach((key, i) => {
                if (previous[i] === undefined) delete process.env[key]
                else process.env[key] = previous[i]
            })
            await rm(sandbox, { recursive: true, force: true })
        }
    })
}
