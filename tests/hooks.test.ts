import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../src/hooks"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { PromptStore } from "../src/prompts/store"
import { createSessionState, SessionStateRegistry } from "../src/state"
import { fromV2SessionMessages } from "../src/v2/messages"

test("hook handlers preserve guards, command interception, sanitization and timing", async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-hooks-test-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    try {
        const logger = new Logger(false, "silent")
        logger.debug = () => undefined
        logger.info = () => undefined
        logger.warn = () => undefined
        logger.error = () => undefined
        const config = getConfig({ directory: sandbox })
        const prompts = new PromptStore(logger, sandbox)
        prompts.reload = () => assert.fail("guarded requests must not reload prompts")

        await t.test("system records model limits before the missing-state guard", async () => {
            const registry = new SessionStateRegistry(logger, sandbox)
            const handler = createSystemPromptHandler(registry, logger, config, prompts)
            const output = { system: ["Original system prompt"] }
            await handler(
                {
                    sessionID: "missing",
                    model: { providerID: "provider", id: "model", limit: { context: 128000 } },
                },
                output,
            )
            assert.equal(registry.get("missing"), undefined)
            assert.equal(registry.resolveModelLimit("provider", "model"), 128000)
            assert.deepEqual(output.system, ["Original system prompt"])
        })

        await t.test(
            "internal system requests do not overwrite session model attribution",
            async () => {
                const state = createSessionState()
                state.modelContextLimit = 64000
                state.modelProviderID = "primary"
                state.modelID = "primary-model"
                const registry = new SessionStateRegistry(logger, sandbox)
                registry.get = () => state
                const handler = createSystemPromptHandler(registry, logger, config, prompts)
                for (const signature of [
                    "You are a title generator",
                    "You are a helpful AI assistant tasked with summarizing conversations",
                    "You are an anchored context summarization assistant for coding sessions",
                    "Summarize what was done in this conversation",
                ]) {
                    const output = { system: [signature] }
                    await handler(
                        {
                            sessionID: "session",
                            model: {
                                providerID: "internal",
                                id: "small-model",
                                limit: { context: 8000 },
                            },
                        },
                        output,
                    )
                    assert.deepEqual(output.system, [signature])
                    assert.equal(state.modelContextLimit, 64000)
                    assert.equal(state.modelProviderID, "primary")
                    assert.equal(state.modelID, "primary-model")
                }
                assert.equal(registry.resolveModelLimit("internal", "small-model"), 8000)
            },
        )

        await t.test(
            "internal message agents are excluded before resolving session state",
            async () => {
                const registry = {
                    getOrCreate() {
                        assert.fail("internal agents must not resolve session state")
                    },
                } as unknown as SessionStateRegistry
                const handler = createChatMessageTransformHandler(
                    {},
                    registry,
                    logger,
                    config,
                    prompts,
                    { global: undefined, agents: {} },
                )
                for (const agent of ["title", "summary", "compaction"]) {
                    const messages = fromV2SessionMessages(
                        [{ id: "user", type: "user", text: "Internal request", createdAt: 100 }],
                        "session",
                    )
                    messages[0].info.agent = agent
                    const original = structuredClone(messages)
                    await handler({}, { messages })
                    assert.deepEqual(messages, original)
                }
            },
        )

        await t.test(
            "disabled and unrelated commands do not fetch; help emits the sentinel",
            async () => {
                const calls: string[] = []
                const notifications: Array<{
                    sessionID: string
                    text: string
                    description: string
                }> = []
                const client = {
                    session: {
                        async context({ sessionID }: { sessionID: string }) {
                            calls.push(sessionID)
                            return []
                        },
                        async synthetic(notification: (typeof notifications)[number]) {
                            notifications.push(notification)
                        },
                    },
                }
                const state = createSessionState()
                let resolutions = 0
                const registry = {
                    async getOrCreate() {
                        resolutions++
                        return state
                    },
                } as unknown as SessionStateRegistry
                const commandConfig = {
                    ...config,
                    commands: { ...config.commands, enabled: false },
                }
                const handler = createCommandExecuteHandler(
                    client,
                    registry,
                    logger,
                    commandConfig,
                    sandbox,
                    { global: undefined, agents: {} },
                )
                const output = { parts: [{ type: "text", text: "Existing part" }] }
                const original = structuredClone(output)
                await handler({ command: "acp", sessionID: "session", arguments: "help" }, output)
                commandConfig.commands.enabled = true
                await handler({ command: "other", sessionID: "session", arguments: "help" }, output)
                assert.deepEqual(calls, [])
                assert.equal(resolutions, 0)
                assert.deepEqual(notifications, [])
                assert.deepEqual(output, original)

                await assert.rejects(
                    handler({ command: "acp", sessionID: "session", arguments: " HELP " }, output),
                    { message: "__ACP_CONTEXT_HANDLED__" },
                )
                assert.deepEqual(calls, ["session"])
                assert.equal(resolutions, 1)
                assert.equal(notifications.length, 1)
                assert.equal(notifications[0].sessionID, "session")
                assert.equal(notifications[0].description, "ACP")
                assert.match(notifications[0].text, /^\[ACP\] Available commands:/)
                assert.ok(notifications[0].text.includes("/acp help"))
                assert.deepEqual(output, original)
            },
        )

        await t.test(
            "text sanitization strips tags without state and trailing refs with state",
            async () => {
                const state = createSessionState()
                const registry = new SessionStateRegistry(logger, sandbox)
                registry.get = (sessionID) => (sessionID === "known" ? state : undefined)
                const handler = createTextCompleteHandler(registry, logger)
                const input = { sessionID: "missing", messageID: "message", partID: "part" }
                const tagged = { text: ["Answer", "<", "acp-message-id>", "\nm00001"].join("") }
                await handler(input, tagged)
                assert.equal(tagged.text, "Answer\nm00001")
                const leaked = { text: "Answer\nm00001" }
                await handler({ ...input, sessionID: "known" }, leaked)
                assert.equal(leaked.text, "Answer")
                const ordinary = { text: "Discuss m00001 inline.\nKeep this text." }
                await handler({ ...input, sessionID: "known" }, ordinary)
                assert.equal(ordinary.text, "Discuss m00001 inline.\nKeep this text.")
                const empty = { text: "" }
                await handler(input, empty)
                assert.equal(empty.text, "")
            },
        )

        await t.test(
            "events retain first pending time, queue completion and clear failed starts",
            async () => {
                const registry = new SessionStateRegistry(logger, sandbox)
                const handler = createEventHandler(registry, logger)
                const timing = registry.compressionTiming
                const event = (
                    status: string,
                    time: number,
                    messageID = "message",
                    toolTime?: { start: number; end: number },
                ) => ({
                    event: {
                        type: "message.part.updated",
                        time,
                        properties: {
                            part: {
                                type: "tool",
                                tool: "acp_compress",
                                callID: "call",
                                messageID,
                                state: { status, time: toolTime },
                            },
                        },
                    },
                })
                await handler(event("pending", 100))
                await handler(event("pending", 150))
                await handler(event("running", 200))
                assert.equal(timing.startsByCallId.get("message:call"), 100)
                await handler(event("completed", 900, "message", { start: 400, end: 900 }))
                assert.equal(timing.startsByCallId.has("message:call"), false)
                assert.deepEqual(timing.pendingByCallId.get("message:call"), {
                    messageId: "message",
                    callId: "call",
                    durationMs: 300,
                })

                await handler(event("pending", 1000, "failed-message"))
                await handler(event("failed", 1100, "failed-message"))
                assert.equal(timing.startsByCallId.has("failed-message:call"), false)
                assert.equal(timing.pendingByCallId.has("failed-message:call"), false)
                assert.equal(timing.pendingByCallId.size, 1)

                await handler(
                    event("completed", 1400, "without-pending", { start: 1200, end: 1400 }),
                )
                assert.deepEqual(timing.pendingByCallId.get("without-pending:call"), {
                    messageId: "without-pending",
                    callId: "call",
                    durationMs: 200,
                })
            },
        )
    } finally {
        keys.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key]
            else process.env[key] = previous[i]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})
