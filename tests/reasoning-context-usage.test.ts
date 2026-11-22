import assert from "node:assert/strict"
import { test } from "node:test"
import { getConfig } from "../src/config"
import {
    countAllMessageTokens,
    countTokens,
    estimateTokensBatch,
    getCurrentTokenUsage,
} from "../src/context-usage"
import { Logger } from "../src/logger"
import { enforceContextBudget, estimateWireTokens } from "../src/messages/enforce-budget"
import { dropCompressReasoning } from "../src/messages/reasoning-strip"
import { createSessionState, type WithParts } from "../src/state"
import { fromV2SessionMessages } from "../src/v2/messages"

function fixture() {
    return fromV2SessionMessages(
        [
            { id: "prompt", type: "user", text: "Inspect the result.", time: { created: 1 } },
            {
                id: "answer",
                type: "assistant",
                time: { created: 2 },
                content: [
                    { type: "text", text: "Answer text." },
                    { type: "reasoning", text: "Visible thinking 中文 ".repeat(100) },
                    { type: "reasoning", text: "Another reasoning part." },
                    { type: "reasoning", text: "" },
                    {
                        type: "tool",
                        id: "compress-call",
                        name: "acp_compress",
                        input: { content: [] },
                        result: "Compression result.",
                    },
                ],
            },
            { id: "next", type: "user", text: "Continue.", time: { created: 3 } },
        ],
        "reasoning-session",
    )
}

function reasoningUsage(message: WithParts): number {
    return message.parts.reduce(
        (sum, part) => sum + (part.type === "reasoning" ? countTokens(part.text) : 0),
        0,
    )
}

test("mixed messages retain text/tool batch accounting and add each visible reasoning part", () => {
    const messages = fixture()
    const message = messages[1]
    const before = structuredClone(message)
    const batch = estimateTokensBatch([
        "Answer text.",
        JSON.stringify({ content: [] }),
        "Compression result.",
    ])
    assert.equal(countAllMessageTokens(message), batch + reasoningUsage(message))
    assert.deepEqual(message, before, "counting must not mutate the request")
    message.parts = message.parts.filter((part) => part.type !== "reasoning")
    assert.equal(countAllMessageTokens(message), batch)
})

test("reasoning-only messages count current text without treating empty or non-text parts as usage", () => {
    const message = fixture()[1]
    message.parts = [{ type: "reasoning", text: "Only reasoning 中文" }]
    assert.equal(countAllMessageTokens(message), countTokens("Only reasoning 中文"))
    message.parts[0].text = "Changed reasoning text"
    assert.equal(countAllMessageTokens(message), countTokens("Changed reasoning text"))
    message.parts = [
        { type: "reasoning", text: "" },
        { type: "file", url: "data:image/png;base64,AA==", mime: "image/png" },
    ]
    assert.equal(countAllMessageTokens(message), 0, "native media costs are not text estimates")
    message.parts = []
    assert.equal(countAllMessageTokens(message), 0)
})

test("fallback and wire estimates include reasoning but stop counting it after request-time removal", () => {
    const messages = fixture()
    const state = createSessionState()
    state.systemPromptTokens = 37
    const reasoning = reasoningUsage(messages[1])
    const expected =
        countTokens("Inspect the result.") +
        estimateTokensBatch([
            "Answer text.",
            JSON.stringify({ content: [] }),
            "Compression result.",
        ]) +
        countTokens("Continue.")
    assert.equal(getCurrentTokenUsage(state, messages), expected + reasoning)
    assert.equal(estimateWireTokens(state, messages), expected + reasoning + 37)
    assert.equal(dropCompressReasoning(messages, 0), 3)
    assert.equal(getCurrentTokenUsage(state, messages), expected)
    assert.equal(estimateWireTokens(state, messages), expected + 37)
})

test("recorded provider usage is unchanged and trailing reasoning is counted once", () => {
    const messages = fixture()
    const state = createSessionState()
    const assistant = messages[1].info
    if (assistant.role !== "assistant") throw new Error("Expected assistant fixture")
    assistant.tokens = { input: 20, output: 0, reasoning: 3, cache: { read: 40, write: 5 } }
    const trailing = fixture()[1]
    trailing.info.id = "trailing"
    trailing.parts = [{ type: "reasoning", text: "New request reasoning." }]
    messages.push(trailing)
    assert.equal(getCurrentTokenUsage(state, messages), 68)
    assert.equal(
        estimateWireTokens(state, messages),
        68 + countTokens("Continue.") + countTokens("New request reasoning."),
    )
    state.lastCompaction = 3
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("budget enforcement detects reasoning that exceeds a text-only budget without dropping it", () => {
    const messages = fixture()
    const state = createSessionState()
    const logger = new Logger(false, "silent")
    const config = getConfig({ directory: process.cwd() })
    config.compress.completionReserveTokens = 0
    const reasoning = reasoningUsage(messages[1])
    const withoutReasoning = messages.map((message) => ({
        ...message,
        parts: message.parts.filter((part) => part.type !== "reasoning"),
    }))
    const textOnly = withoutReasoning.reduce(
        (sum, message) => sum + countAllMessageTokens(message),
        0,
    )
    const total = textOnly + reasoning
    state.modelContextLimit = textOnly + 1
    const before = structuredClone(messages)
    const result = enforceContextBudget(state, config, logger, messages)!
    assert.equal(result.estimatedTokens, total)
    assert.ok(result.finalEstimate > result.budget)
    assert.equal(result.truncatedCount, 0)
    assert.equal(result.clearedCount, 0)
    assert.deepEqual(messages, before)
})
