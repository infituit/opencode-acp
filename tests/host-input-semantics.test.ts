import assert from "node:assert/strict"
import { test } from "node:test"
import type { SelectionResolution } from "../src/compress/types"
import {
    appendProtectedPromptInfo,
    appendProtectedUserMessages,
    filterLastUserMessage,
} from "../src/compress/protected-content"
import { buildSearchContext } from "../src/compress/search"
import type { PluginConfig } from "../src/config"
import { Logger } from "../src/logger"
import { prune } from "../src/messages/prune"
import { buildCompressibleRanges, formatCompressibleRanges } from "../src/messages/inject/utils"
import { buildVisibleSegments, formatVisibleGuidance } from "../src/messages/inject/inject"
import {
    getLastUserMessage,
    getRequestInput,
    isHostInput,
    isSyntheticMessage,
    isUserPrompt,
} from "../src/messages/query"
import { createSyntheticUserMessage } from "../src/messages/utils"
import { createSessionState, type WithParts } from "../src/state"
import { collectTurnNudgeAnchors } from "../src/state/utils"

function user(id: string, host = false): WithParts {
    return {
        info: {
            id,
            sessionID: "session",
            role: "user",
            time: { created: 1 },
            agent: "code",
            model: { providerID: "provider", modelID: "model" },
            ...(host ? { hostInput: { metadata: { source: "handoff" } } } : {}),
        },
        parts: [{ type: "text", text: `${id} <protect>${id} protected</protect>` }],
    }
}

function assistant(id: string): WithParts {
    return {
        info: {
            id,
            sessionID: "session",
            role: "assistant",
            time: { created: 2 },
            parentID: "",
            modelID: "model",
            providerID: "provider",
            mode: "code",
            agent: "code",
            path: { cwd: "", root: "" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: "text", text: id }],
    }
}

test("human prompt getters exclude host deliveries, ignored users and ACP synthetic messages", () => {
    const human = user("human")
    const host = user("host", true)
    const ignored = user("ignored")
    ignored.parts[0].ignored = true
    const synthetic = createSyntheticUserMessage(human, "ACP guidance")
    const messages = [human, ignored, host, synthetic]
    assert.equal(isHostInput(host), true)
    assert.equal(isUserPrompt(host), false)
    assert.equal(isUserPrompt(ignored), false)
    assert.equal(isUserPrompt(synthetic), false)
    assert.equal(getLastUserMessage(messages), human)
    assert.equal(getLastUserMessage(messages, 0), human)
    assert.equal(getRequestInput(messages), human, "human input takes attribution precedence")
    assert.equal(getLastUserMessage([host, synthetic]), null)
    assert.equal(getRequestInput([host, synthetic]), host)
    assert.equal(getRequestInput([ignored, synthetic]), null)
    assert.equal(getRequestInput([]), null)
})

test("host deliveries do not create human turn nudge anchors", () => {
    const first = assistant("first")
    const human = user("human")
    const second = assistant("second")
    const host = user("host", true)
    assert.deepEqual(collectTurnNudgeAnchors([first, host]), new Set())
    assert.deepEqual(
        collectTurnNudgeAnchors([first, human, second, host]),
        new Set(["first", "human"]),
    )
})

test("protected user and prompt enrichment preserves only human content", () => {
    const state = createSessionState()
    const human = user("human")
    const host = user("host", true)
    const synthetic = createSyntheticUserMessage(human, "<protect>ACP protected</protect>")
    const messages = [human, host, synthetic]
    const search = buildSearchContext(state, messages)
    const selection: SelectionResolution = {
        startReference: { kind: "message", rawIndex: 0, messageId: human.info.id },
        endReference: { kind: "message", rawIndex: 2, messageId: synthetic.info.id },
        messageIds: messages.map((message) => message.info.id),
        messageTokenById: new Map(),
        toolIds: [],
        requiredBlockIds: [],
    }
    const userSummary = appendProtectedUserMessages("summary", selection, search, state, true)
    assert.match(userSummary, /human <protect>human protected<\/protect>/)
    assert.doesNotMatch(userSummary, /host|ACP protected/)
    const promptSummary = appendProtectedPromptInfo("summary", selection, search, state, true)
    assert.match(promptSummary, /human protected/)
    assert.doesNotMatch(promptSummary, /host|ACP protected/)
    assert.deepEqual(
        filterLastUserMessage(selection, search, state, {} as PluginConfig["compress"]).messageIds,
        [host.info.id, synthetic.info.id],
    )
})

test("prune retains the first human task rather than an earlier host payload", () => {
    const state = createSessionState()
    const host = user("host", true)
    const human = user("human")
    for (const message of [host, human]) {
        state.prune.messages.byMessageId.set(message.info.id, {
            tokenCount: 10,
            allBlockIds: [1],
            activeBlockIds: [1],
        })
    }
    const messages = [host, human, assistant("answer")]
    prune(state, new Logger(false, "silent"), {} as PluginConfig, messages)
    assert.deepEqual(
        messages.map((message) => message.info.id),
        ["human", "answer"],
    )
})

test("prune replaces compressed host-only input with a stable payload-free wire placeholder", () => {
    const state = createSessionState()
    const host = user("host payload must not return", true)
    state.prune.messages.byMessageId.set(host.info.id, {
        tokenCount: 10,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const messages = [host, assistant("answer")]
    prune(state, new Logger(false, "silent"), {} as PluginConfig, messages)
    const placeholder = messages[0]
    assert.equal(placeholder.info.role, "user")
    assert.equal(isSyntheticMessage(placeholder), true)
    assert.equal(isUserPrompt(placeholder), false)
    assert.equal(isHostInput(placeholder), false)
    assert.doesNotMatch(JSON.stringify(messages), /host payload must not return/)
    assert.equal(messages[1].info.id, "answer")
    const placeholderId = placeholder.info.id
    prune(state, new Logger(false, "silent"), {} as PluginConfig, messages)
    assert.equal(messages[0].info.id, placeholderId)
    assert.equal(messages.length, 2)
    const replay = [host, assistant("answer")]
    prune(state, new Logger(false, "silent"), {} as PluginConfig, replay)
    assert.equal(replay[0].info.id, placeholderId)
})

function rangeState(messages: WithParts[], refs: (string | undefined)[]) {
    const state = createSessionState()
    messages.forEach((message, index) => {
        const ref = refs[index]
        if (ref) state.messageIds.byRawId.set(message.info.id, ref)
    })
    return state
}

function protectedMessage(id: string): WithParts {
    const message = assistant(id)
    message.parts = [
        {
            type: "tool",
            tool: "read",
            callID: id,
            state: { status: "completed", output: id },
        },
    ]
    return message
}

test("range grouping follows transcript adjacency despite backfilled aliases", () => {
    const messages = [user("human"), user("host", true), assistant("answer")]
    const state = rangeState(messages, ["m00001", "m00003", "m00002"])
    const ranges = buildCompressibleRanges(messages, state)
    assert.deepEqual(
        ranges.compressible.map(({ startRef, endRef, count, startIndex, endIndex }) => ({
            startRef,
            endRef,
            count,
            startIndex,
            endIndex,
        })),
        [{ startRef: "m00001", endRef: "m00002", count: 3, startIndex: 0, endIndex: 2 }],
    )
    const protectedMessages = [protectedMessage("first"), protectedMessage("second")]
    const protectedState = rangeState(protectedMessages, ["m00003", "m00001"])
    const protectedRanges = buildCompressibleRanges(protectedMessages, protectedState, ["read"])
    assert.equal(protectedRanges.protected.length, 1)
    assert.equal(protectedRanges.protected[0].endRef, "m00001")
    assert.equal(protectedRanges.protected[0].count, 2)
})

test("range guidance stays chronological and never merges across protection boundaries", () => {
    const messages = [assistant("first"), protectedMessage("protected"), user("host", true)]
    const state = rangeState(messages, ["m00001", "m00003", "m00002"])
    const ranges = buildCompressibleRanges(messages, state, ["read"])
    const guidance = formatCompressibleRanges(ranges.compressible, ranges.protected)
    const lines = guidance.split("\n").slice(1)
    assert.equal(lines.length, 3)
    assert.match(lines[0], /m00001–m00001/)
    assert.match(lines[1], /m00003–m00003.*PROTECTED/)
    assert.match(lines[2], /m00002–m00002/)
    assert.doesNotMatch(guidance, /compressible \|/)
})

test("hidden and protected-zone transcript gaps split ranges even for consecutive aliases", () => {
    const messages = [
        assistant("first"),
        assistant("hidden"),
        assistant("second"),
        assistant("protected-zone"),
        assistant("third"),
        protectedMessage("protected"),
    ]
    const state = rangeState(messages, [
        "m00001",
        undefined,
        "m00002",
        "m00006",
        "m00003",
        "m00004",
    ])
    const ranges = buildCompressibleRanges(messages, state, ["read"], [], new Set(["m00006"]))
    assert.deepEqual(
        ranges.compressible.map((range) => range.count),
        [1, 1, 1],
    )
    const lines = formatCompressibleRanges(ranges.compressible, ranges.protected)
        .split("\n")
        .slice(1)
    assert.equal(lines.length, 4)
    assert.match(lines[0], /m00001–m00001/)
    assert.match(lines[1], /m00002–m00002/)
    assert.match(lines[2], /m00003–m00003/)
    assert.match(lines[3], /m00004–m00004.*PROTECTED/)

    const protectedMessages = [
        protectedMessage("before"),
        assistant("hidden"),
        protectedMessage("after"),
    ]
    const protectedState = rangeState(protectedMessages, ["m00001", undefined, "m00002"])
    const protectedRanges = buildCompressibleRanges(protectedMessages, protectedState, ["read"])
    assert.deepEqual(
        protectedRanges.protected.map((range) => range.count),
        [1, 1],
    )
    assert.equal(formatCompressibleRanges([], protectedRanges.protected).split("\n").length, 3)
})

test("visible segments preserve backfilled chronology without reversed ranges", () => {
    const messages = [user("human"), user("host", true), assistant("pruned"), assistant("answer")]
    const state = rangeState(messages, ["m00001", "m00004", "m00002", "m00003"])
    const visible = [messages[0], messages[1], messages[3]]
    const segments = buildVisibleSegments(state, visible)
    assert.deepEqual(
        segments.map(({ startRef, endRef, count }) => ({ startRef, endRef, count })),
        [
            { startRef: "m00001", endRef: "m00001", count: 1 },
            { startRef: "m00004", endRef: "m00004", count: 1 },
            { startRef: "m00003", endRef: "m00003", count: 1 },
        ],
    )
    assert.equal(
        formatVisibleGuidance(segments, 50),
        "[Visible: m00001, m00004, m00003 (3 msgs, 3 segments)]",
    )
    assert.doesNotMatch(formatVisibleGuidance(segments, 50), /m00003–m00004|m00004–m00003/)
})

test("visible segments merge monotonic neighbors but never cross hidden transcript or ref gaps", () => {
    const messages = [
        assistant("first"),
        assistant("second"),
        assistant("third"),
        assistant("fourth"),
    ]
    const monotonic = rangeState(messages, ["m00001", "m00002", "m00003", "m00005"])
    assert.deepEqual(
        buildVisibleSegments(monotonic, messages).map(({ startRef, endRef, count }) => ({
            startRef,
            endRef,
            count,
        })),
        [
            { startRef: "m00001", endRef: "m00003", count: 3 },
            { startRef: "m00005", endRef: "m00005", count: 1 },
        ],
    )
    const hidden = rangeState(messages, ["m00001", undefined, "m00002", "m00003"])
    assert.deepEqual(
        buildVisibleSegments(hidden, messages).map(({ startRef, endRef, count }) => ({
            startRef,
            endRef,
            count,
        })),
        [
            { startRef: "m00001", endRef: "m00001", count: 1 },
            { startRef: "m00002", endRef: "m00003", count: 2 },
        ],
    )
    const removed = [messages[0], messages[2], messages[3]]
    const refGap = rangeState(messages, ["m00001", "m00002", "m00003", "m00004"])
    assert.deepEqual(
        buildVisibleSegments(refGap, removed).map(({ startRef, endRef, count }) => ({
            startRef,
            endRef,
            count,
        })),
        [
            { startRef: "m00001", endRef: "m00001", count: 1 },
            { startRef: "m00003", endRef: "m00004", count: 2 },
        ],
    )
})
