import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

test("token counting reuses the encoder, preserves counts and recovers after failures", async (t) => {
    const upstream = createRequire(import.meta.url)(
        "@anthropic-ai/tokenizer",
    ) as typeof import("@anthropic-ai/tokenizer")
    const samples = [
        "An English sentence: 12345!",
        "中文と日本語 한국어 العربية",
        "ＡＢＣ ﬁ ① e\u0301 café 👨‍👩‍👧‍👦",
        "<EOT> <META> <|endoftext|>",
        "const value = await readFile(path);\n".repeat(80),
        "\ud800 lone surrogate \udfff",
    ]
    const expected = samples.map(upstream.countTokens)
    const retryText = "中文".repeat(10)
    const retryExpected = upstream.countTokens(retryText)
    const batchExpected = upstream.countTokens(samples.join(" "))
    const changedExpected = upstream.countTokens(
        [JSON.stringify({ path: "changed" }), "Changed 中文"].join(" "),
    )
    const getTokenizer = upstream.getTokenizer
    let constructions = 0
    let encodes = 0
    let releases = 0
    let failConstruction = true
    let failEncoding = false
    let failDisposal = false
    t.mock.method(upstream, "getTokenizer", () => {
        constructions++
        if (failConstruction) throw new Error("synthetic initialization failure")
        const encoder = getTokenizer()
        const encode = encoder.encode.bind(encoder)
        const free = encoder.free.bind(encoder)
        t.mock.method(encoder, "encode", (...args: Parameters<typeof encode>) => {
            encodes++
            if (failEncoding) throw new Error("synthetic encoding failure")
            return encode(...args)
        })
        t.mock.method(encoder, "free", () => {
            releases++
            free()
            if (failDisposal) throw new Error("synthetic disposal failure")
        })
        return encoder
    })
    const { countTokens, estimateTokensBatch, getCurrentTokenUsage, countAllMessageTokens } =
        await import("../src/context-usage")
    const { createSessionState } = await import("../src/state")
    const { fromV2SessionMessages } = await import("../src/v2/messages")
    assert.equal(countTokens(""), 0)
    assert.equal(constructions, 0)
    assert.equal(countTokens(retryText), Math.round(retryText.length / 4))
    failConstruction = false
    assert.equal(countTokens(retryText), retryExpected)
    assert.equal(constructions, 2)
    const before = constructions
    for (let repeat = 0; repeat < 2; repeat++) {
        samples.forEach((text, i) => assert.equal(countTokens(text), expected[i]))
    }
    assert.equal(constructions, before, "successful counts share the existing encoder")
    assert.equal(estimateTokensBatch([]), 0)
    assert.equal(estimateTokensBatch(samples), batchExpected)

    for (const disposalFails of [false, true]) {
        failEncoding = true
        failDisposal = disposalFails
        const releasedBefore = releases
        assert.equal(countTokens(retryText), Math.round(retryText.length / 4))
        assert.equal(releases, releasedBefore + 1)
        failEncoding = false
        failDisposal = false
        const constructedBefore = constructions
        assert.equal(countTokens(samples[0]), expected[0])
        assert.equal(constructions, constructedBefore + 1, "retry replaces a failed encoder")
    }

    const messages = fromV2SessionMessages(
        [
            { id: "user", type: "user", text: "Inspect this output.", time: { created: 1 } },
            {
                id: "assistant",
                type: "assistant",
                time: { created: 2 },
                content: [
                    { type: "tool", id: "read", name: "read", input: {}, result: "Original" },
                ],
            },
        ],
        "session",
    )
    const state = createSessionState()
    assert.equal(
        getCurrentTokenUsage(state, messages),
        messages.reduce((sum, message) => sum + countAllMessageTokens(message), 0),
    )
    const tool = messages[1].parts[0]
    assert.equal(tool.type, "tool")
    if (tool.type !== "tool") throw new Error("Expected tool fixture")
    tool.state = { status: "completed", input: { path: "changed" }, output: "Changed 中文" }
    assert.equal(countAllMessageTokens(messages[1]), changedExpected)
    const assistant = messages[1].info
    if (assistant.role !== "assistant") throw new Error("Expected assistant fixture")
    assistant.tokens = { input: 20, output: 0, reasoning: 3, cache: { read: 40, write: 5 } }
    const encodesBefore = encodes
    assert.equal(getCurrentTokenUsage(state, messages), 68)
    state.lastCompaction = 3
    assert.equal(getCurrentTokenUsage(state, messages), 0)
    assert.equal(encodes, encodesBefore, "native usage and compaction do not encode history")
})
