import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import { test } from "node:test"
import { getCurrentTokenUsage, getCurrentTokenUsageAsync } from "../src/context-usage"
import { diagnoseContext } from "../src/diagnostics"
import { Logger } from "../src/logger"
import { createSessionState } from "../src/state"
import { fromV2SessionMessages } from "../src/v2/messages"

function fixture(session = "cooperative") {
    return fromV2SessionMessages(
        [
            { id: "prompt", type: "user", text: "Inspect 中文 ﬁ 👨‍👩‍👧‍👦" },
            ...Array.from({ length: 12 }, (_, index) => ({
                id: `answer-${index}`,
                type: "assistant",
                content: [
                    { type: "text", text: `Answer ${index}` },
                    { type: "reasoning", text: `Reasoning ${index} 中文` },
                    {
                        type: "tool",
                        id: `call-${index}`,
                        name: "read",
                        input: { path: `src/${index}.ts` },
                        result: `Result ${index} <|endoftext|> \ud800`,
                    },
                ],
            })),
        ],
        session,
    )
}

const logger = new Logger(false, "info")
logger.debug = () => undefined
logger.diagnostic = async () => {}

test("cooperative accounting yields between messages and keeps concurrent diagnostics isolated", async (t) => {
    // A deterministic expired time slice tests scheduling, not machine speed.
    let clock = 0
    t.mock.method(performance, "now", () => (clock += 10))
    const first = fixture("first")
    const second = fixture("second").slice(0, 4)
    const expectedCounters = await Promise.all(
        [first, second].map((messages) =>
            diagnoseContext(logger, "sync", async (diagnostic) => {
                getCurrentTokenUsage(createSessionState(), messages)
                const { tokenizerCalls, tokenizerChars } = diagnostic!.tokens
                return { tokenizerCalls, tokenizerChars }
            }),
        ),
    )
    let visited = 0
    for (const message of first) {
        const parts = message.parts
        Object.defineProperty(message, "parts", {
            get: () => {
                visited++
                return parts
            },
        })
    }
    let heartbeatVisited = -1
    const heartbeat = nextTurn().then(() => {
        heartbeatVisited = visited
    })
    const results = await Promise.all(
        [first, second].map((messages, index) =>
            diagnoseContext(logger, `request-${index}`, async (diagnostic) => {
                const result = await getCurrentTokenUsageAsync(createSessionState(), messages)
                assert.equal(diagnostic!.tokens.usageCalls, 1)
                assert.equal(diagnostic!.tokens.fullHistoryFallback, 1)
                assert.equal(diagnostic!.tokens.fallbackMessages, messages.length)
                assert.equal(
                    diagnostic!.tokens.tokenizerCalls,
                    expectedCounters[index].tokenizerCalls,
                )
                assert.equal(
                    diagnostic!.tokens.tokenizerChars,
                    expectedCounters[index].tokenizerChars,
                )
                return result
            }),
        ),
    )
    await heartbeat
    assert.ok(heartbeatVisited > 0, "counting started before yielding")
    assert.ok(heartbeatVisited < visited, "queued work ran before the history finished")
    assert.deepEqual(
        results,
        [first, second].map((messages) => getCurrentTokenUsage(createSessionState(), messages)),
    )
})

test("each cooperative count sees current content, pruning and injected messages", async () => {
    const messages = fixture()
    const state = createSessionState()
    const verify = async () => {
        const expected = getCurrentTokenUsage(state, messages)
        assert.equal(await getCurrentTokenUsageAsync(state, messages), expected)
        return expected
    }
    const original = await verify()
    const part = messages[1].parts.find((part) => part.type === "tool")!
    if (part.type !== "tool") throw new Error("Expected tool fixture")
    part.state = { status: "completed", input: { path: "changed" }, output: "Changed".repeat(100) }
    assert.notEqual(await verify(), original)
    part.state.time = { compacted: 1 }
    await verify()
    messages.splice(2, 5)
    await verify()
    messages.push(...fixture("injected").slice(0, 1))
    await verify()
    messages[1].parts = messages[1].parts.filter((part) => part.type !== "reasoning")
    await verify()
})

test("provider usage, compaction reset and empty histories keep the synchronous semantics", async () => {
    const state = createSessionState()
    const messages = fixture()
    const assistant = messages.at(-1)!.info
    if (assistant.role !== "assistant") throw new Error("Expected assistant fixture")
    assistant.time.created = 2
    assistant.tokens = { input: 20, output: 0, reasoning: 3, cache: { read: 40, write: 5 } }
    messages.push(...fixture("trailing-without-usage").slice(0, 2))
    await diagnoseContext(logger, "provider", async (diagnostic) => {
        assert.equal(await getCurrentTokenUsageAsync(state, messages), 68)
        state.lastCompaction = 3
        assert.equal(await getCurrentTokenUsageAsync(state, messages), 0)
        state.lastCompaction = assistant.time.created
        assert.equal(await getCurrentTokenUsageAsync(state, messages), 68)
        assistant.summary = true
        assert.equal(await getCurrentTokenUsageAsync(state, messages), 0)
        assert.equal(diagnostic!.tokens.providerUsage, 2)
        assert.equal(diagnostic!.tokens.compactionReset, 2)
        assert.equal(diagnostic!.tokens.fullHistoryFallback, 0)
        assert.equal(diagnostic!.tokens.tokenizerCalls, 0)
    })
    assert.equal(await getCurrentTokenUsageAsync(state, []), 0)
})
