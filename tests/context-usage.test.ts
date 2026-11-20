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
        "distinct raw \ud800",
        "distinct raw \ud801",
        "distinct raw \ufffd",
    ]
    const expected = samples.map(upstream.countTokens)
    const retryText = "中文".repeat(10)
    const retryExpected = upstream.countTokens(retryText)
    const batchExpected = upstream.countTokens(samples.join(" "))
    const changedExpected = upstream.countTokens(
        [JSON.stringify({ path: "changed" }), "Changed 中文"].join(" "),
    )
    const failureTexts = [false, true].map((value) => `uncached failure ${value} 中文`)
    const failureExpected = failureTexts.map(upstream.countTokens)
    const getTokenizer = upstream.getTokenizer
    let constructions = 0
    let encodes = 0
    let releases = 0
    let failConstruction = true
    let failEncoding = false
    let failDisposal = false
    let syntheticCounts = false
    const syntheticCount = (text: string) =>
        1 +
        (Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).reduce(
            (a, b) => a + b,
            0,
        ) %
            13)
    t.mock.method(upstream, "getTokenizer", () => {
        constructions++
        if (failConstruction) throw new Error("synthetic initialization failure")
        const encoder = getTokenizer()
        const encode = encoder.encode.bind(encoder)
        const free = encoder.free.bind(encoder)
        t.mock.method(encoder, "encode", (...args: Parameters<typeof encode>) => {
            encodes++
            if (failEncoding) throw new Error("synthetic encoding failure")
            if (syntheticCounts)
                return new Uint32Array(args[0] === "synthetic-zero" ? 0 : syntheticCount(args[0]))
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
    const { diagnoseContext } = await import("../src/diagnostics")
    const { Logger } = await import("../src/logger")
    assert.equal(countTokens(""), 0)
    assert.equal(constructions, 0)
    assert.equal(countTokens(retryText), Math.round(retryText.length / 4))
    failConstruction = false
    assert.equal(countTokens(retryText), retryExpected)
    assert.equal(constructions, 2)
    const before = constructions
    const encodesBeforeSamples = encodes
    for (let repeat = 0; repeat < 2; repeat++) {
        samples.forEach((text, i) => assert.equal(countTokens(text), expected[i]))
    }
    assert.equal(constructions, before, "successful counts share the existing encoder")
    assert.equal(encodes - encodesBeforeSamples, samples.length, "unchanged text is encoded once")
    assert.equal(estimateTokensBatch([]), 0)
    assert.equal(estimateTokensBatch(samples), batchExpected)

    for (const disposalFails of [false, true]) {
        const failureText = `uncached failure ${disposalFails} 中文`
        failEncoding = true
        failDisposal = disposalFails
        const releasedBefore = releases
        assert.equal(countTokens(failureText), Math.round(failureText.length / 4))
        assert.equal(releases, releasedBefore + 1)
        failEncoding = false
        failDisposal = false
        const constructedBefore = constructions
        assert.equal(countTokens(failureText), failureExpected[Number(disposalFails)])
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

    // Use a deterministic encoder to stress the shared cache without measuring
    // WASM throughput. Distinct raw strings must never share an entry.
    syntheticCounts = true
    const surrogateSamples = ["raw \ud800", "raw \ud801", "raw \udfff", "raw \ufffd"]
    const beforeSurrogates = encodes
    for (const text of surrogateSamples) assert.equal(countTokens(text), syntheticCount(text))
    assert.equal(encodes - beforeSurrogates, surrogateSamples.length)

    const beforeZero = encodes
    assert.equal(countTokens("synthetic-zero"), 0)
    assert.equal(countTokens("synthetic-zero"), 0)
    assert.equal(encodes, beforeZero + 1, "an exact zero is a cache hit, not a miss")

    const retained = "interleaved-session-retained"
    assert.equal(countTokens(retained), syntheticCount(retained))
    for (let i = 0; i < 65_535; i++) countTokens(`interleaved-session-${i}`)
    const beforeHit = encodes
    assert.equal(countTokens(retained), syntheticCount(retained))
    assert.equal(encodes, beforeHit, "bounded cache retains the combined working set")
    // Refreshing retained makes the other entry oldest. Grow beyond capacity.
    countTokens("overflow-session-entry")
    assert.equal(countTokens(retained), syntheticCount(retained))
    const beforeEvicted = encodes
    countTokens("interleaved-session-0")
    assert.equal(encodes, beforeEvicted + 1, "evicted content is encoded again")
    const afterEvicted = encodes
    countTokens("interleaved-session-0")
    assert.equal(encodes, afterEvicted, "successful zero/positive results remain reusable")

    const logger = new Logger(false, "info")
    logger.debug = () => undefined
    logger.diagnostic = async () => {}
    await diagnoseContext(logger, "eviction", async (diagnostic) => {
        const counters = diagnostic!.tokens
        const value = "new-record-at-capacity"
        assert.equal(countTokens(value), syntheticCount(value))
        assert.equal(countTokens(value), syntheticCount(value))
        assert.equal(counters.cacheMisses, 1)
        assert.equal(counters.cacheHits, 1)
        assert.equal(counters.cacheEvictions, 1)
        assert.equal(counters.tokenizerCalls, 2)
        assert.equal(counters.tokenizerErrors, 0)
        failEncoding = true
        assert.equal(
            countTokens("uncached-error-record"),
            Math.round("uncached-error-record".length / 4),
        )
        assert.equal(counters.tokenizerErrors, 1)
        assert.equal(counters.cacheEvictions, 1, "failed estimates do not enter the cache")
        failEncoding = false
    })
    await diagnoseContext(logger, "provider", async (diagnostic) => {
        state.lastCompaction = 0
        assert.equal(getCurrentTokenUsage(state, messages), 68)
        state.lastCompaction = 3
        assert.equal(getCurrentTokenUsage(state, messages), 0)
        assert.equal(diagnostic!.tokens.usageCalls, 2)
        assert.equal(diagnostic!.tokens.providerUsage, 1)
        assert.equal(diagnostic!.tokens.compactionReset, 1)
        assert.equal(diagnostic!.tokens.fullHistoryFallback, 0)
        assert.equal(diagnostic!.tokens.tokenizerCalls, 0)
    })
})
