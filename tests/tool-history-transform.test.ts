import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatMessageTransformHandler } from "../src/v2/hooks"
import { createSessionState, type SessionStateRegistry } from "../src/state"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { PromptStore } from "../src/prompts/store"
import { fromV2SessionMessages } from "../src/v2/messages"
import { getCurrentTokenUsage } from "../src/context-usage"

test("tool history preserves content, IDs and token accounting across repeated transforms", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-tool-history-test-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    try {
        const logger = new Logger(false, "silent")
        const config = getConfig({ directory: sandbox })
        config.compress.images.enabled = false
        // Disable prompt injection so the assertions compare original tool content.
        config.compress.permission = "deny"
        const prompts = new PromptStore(logger, sandbox)
        for (const size of [2, 1001]) {
            const state = createSessionState()
            state.sessionId = "session"
            state.storageDir = sandbox
            const registry = {
                async getOrCreate() {
                    return state
                },
                resolveModelLimit() {
                    return 128000
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
            const messages = fromV2SessionMessages(
                [
                    { id: "user", type: "user", text: "Inspect tool history.", createdAt: 100 },
                    {
                        id: "assistant",
                        type: "assistant",
                        createdAt: 200,
                        content: Array.from({ length: size }, (_, i) => ({
                            type: "tool",
                            id: `tool-${i}`,
                            name: "read",
                            input: { path: `file-${i}.txt` },
                            result: `File ${i} contents.`,
                        })),
                    },
                ],
                "session",
            )
            const expectedIds = Array.from({ length: size }, (_, i) => `tool-${i}`)
            const check = async () => {
                const original = structuredClone(messages)
                const tokens = getCurrentTokenUsage(state, original)
                assert.ok(tokens > 0)
                const output = { messages: structuredClone(messages) }
                await handler({}, output)
                assert.deepEqual(output.messages, original)
                assert.deepEqual(state.toolIdList, expectedIds)
                assert.equal("toolParameters" in state, false)
                assert.equal(getCurrentTokenUsage(state, output.messages), tokens)
            }
            await check()
            await check()
            const part = messages[1].parts[0]
            assert.equal(part.type, "tool")
            if (part.type !== "tool") throw new Error("Expected tool fixture")
            part.state = { status: "running", input: { path: "updated.txt" } }
            await check()
            part.state = {
                status: "completed",
                input: { path: "updated.txt" },
                output: "Updated file contents.",
            }
            await check()
            part.state = {
                status: "error",
                input: { path: "missing.txt" },
                error: "File not found",
            }
            await check()
        }
    } finally {
        keys.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key]
            else process.env[key] = previous[i]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})
