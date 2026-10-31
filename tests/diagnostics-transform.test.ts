import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnoseContext } from "../src/diagnostics"
import { Logger } from "../src/logger"
import { createChatMessageTransformHandler } from "../src/hooks"
import { createSessionState, type SessionStateRegistry } from "../src/state"
import { getConfig } from "../src/config"
import { PromptStore } from "../src/prompts/store"
import { fromV2SessionMessages } from "../src/v2/messages"

test("real transform preserves output with diagnostics and covers early return and failure", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-transform-test-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    try {
        const records: any[] = []
        const logger = new Logger(false, "info")
        logger.info = () => undefined
        logger.warn = () => undefined
        logger.error = () => undefined
        logger.diagnostic = async (_, record) => {
            records.push(record)
        }
        const config = getConfig({ directory: sandbox })
        config.compress.images.enabled = false
        config.compress.maxContextLimit = Number.MAX_SAFE_INTEGER
        config.compress.minContextLimit = Number.MAX_SAFE_INTEGER
        config.compress.iterationNudgeThreshold = Number.MAX_SAFE_INTEGER
        const messages = () =>
            fromV2SessionMessages(
                [
                    { id: "user", type: "user", text: "Inspect synthetic output.", createdAt: 100 },
                    {
                        id: "assistant",
                        type: "assistant",
                        createdAt: 200,
                        content: [
                            {
                                type: "tool",
                                id: "tool",
                                name: "read",
                                input: {},
                                result: "Synthetic record. ".repeat(30),
                            },
                        ],
                    },
                ],
                "session",
            )
        const fixture = (isSubAgent = false, failure?: Error) => {
            const state = createSessionState()
            state.sessionId = "session"
            state.storageDir = sandbox
            state.isSubAgent = isSubAgent
            const registry = {
                async getOrCreate() {
                    if (failure) throw failure
                    return state
                },
                resolveModelLimit() {
                    return 128000
                },
            } as unknown as SessionStateRegistry
            return createChatMessageTransformHandler(
                {},
                registry,
                logger,
                config,
                new PromptStore(logger, sandbox),
                { global: undefined, agents: {} },
            )
        }
        const input = messages()
        const plain = { messages: structuredClone(input) }
        await fixture()({}, plain)
        assert.equal(records.length, 0)
        const traced = { messages: structuredClone(input) }
        await diagnoseContext(logger, "session", async (request) => {
            request!.timeline("context", "transformMessages")
            await fixture()({}, traced)
        })
        assert.deepEqual(traced, plain)
        assert.equal(records.length, 1)
        for (const stage of [
            "resolveSession",
            "resolveModel",
            "updatePerTurnState",
            "syncToolCache",
            "prePruneTokens",
            "postTokens",
            "saveContext",
        ]) {
            assert.ok(records[0].stageMs.transform[stage] >= 0, stage)
        }
        const internal = messages()
        ;(internal[0].info as any).agent = "title"
        await diagnoseContext(logger, "session", async () => fixture()({}, { messages: internal }))
        assert.equal(records.at(-1).skipReason, "internal_agent")
        config.allowSubAgents = false
        await diagnoseContext(logger, "session", async () =>
            fixture(true)({}, { messages: messages() }),
        )
        assert.equal(records.at(-1).skipReason, "subagent_disabled")
        const original = new Error("synthetic registry failure")
        await assert.rejects(
            diagnoseContext(logger, "session", async () =>
                fixture(false, original)({}, { messages: messages() }),
            ),
            (error) => error === original,
        )
        assert.equal(records.at(-1).failedStage, "transform.resolveSession")
        assert.equal(records.at(-1).status, "error")
    } finally {
        keys.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key]
            else process.env[key] = previous[i]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})
