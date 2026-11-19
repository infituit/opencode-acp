import assert from "node:assert/strict"
import { test } from "node:test"
import { fromV2SessionMessages, toV2RequestMessages } from "../src/v2/messages"

for (const state of ["completed", "error", "cancelled"]) {
    test(`native ${state} delivery retains the host projection and metadata`, () => {
        const metadata = { source: "subagent", state, childID: "child" }
        const durable = [{ id: state, type: "synthetic", text: "durable source", metadata }]
        const request = [
            { id: state, role: "user", content: [{ type: "text", text: "HOST_PROJECTION" }] },
        ]
        const messages = fromV2SessionMessages(durable, "session", request)
        assert.equal(messages.length, 1)
        assert.equal(messages[0].info.role, "user")
        assert.deepEqual(messages[0].info.hostInput, { metadata })
        assert.deepEqual(toV2RequestMessages(messages), [{ ...request[0], metadata }])
        assert.equal(durable[0].text, "durable source")
    })
}

test("the active request supplies delivery content and metadata without sharing mutable parts", () => {
    const durable = [
        {
            id: "delivery",
            type: "synthetic",
            text: "durable source",
            metadata: { source: "subagent", state: "completed" },
        },
    ]
    const request = [
        {
            id: "delivery",
            role: "user",
            content: [{ type: "text", text: "PROJECTED_RESULT" }],
            metadata: { source: "host-projection", delivery: "current" },
        },
    ]
    const messages = fromV2SessionMessages(durable, "session", request)
    assert.deepEqual(toV2RequestMessages(messages), request)
    const part = messages[0].parts[0] as { text: string }
    part.text = "ACP_TRANSFORMED_RESULT"
    assert.equal(request[0].content[0].text, "PROJECTED_RESULT")
    assert.equal(durable[0].text, "durable source")
})

test("an empty request window excludes durable deliveries, while history reads include them", () => {
    const history = [{ id: "delivery", type: "synthetic", text: "RESULT" }]
    assert.deepEqual(fromV2SessionMessages(history, "session", []), [])
    assert.equal(fromV2SessionMessages(history, "session").length, 1)
})

test("ACP notifications are excluded without excluding deliveries from other sources", () => {
    const history = [
        {
            id: "new-notice",
            type: "synthetic",
            text: "NOT_A_PROMPT",
            metadata: { source: "opencode-acp" },
        },
        {
            id: "old-notice",
            type: "synthetic",
            text: "NOT_A_PROMPT",
            description: "ACP: Compress Notification",
        },
        { id: "old-command", type: "synthetic", text: "NOT_A_PROMPT", description: "ACP" },
        {
            id: "old-update",
            type: "synthetic",
            text: "NOT_A_PROMPT",
            description: "ACP update ready",
        },
        {
            id: "peer",
            type: "synthetic",
            text: "PEER_RESULT",
            metadata: { source: "peer" },
            description: "ACP",
        },
        { id: "legacy", type: "synthetic", text: "LEGACY_RESULT" },
    ]
    assert.deepEqual(
        fromV2SessionMessages(history, "session").map((message) => message.info.id),
        ["peer", "legacy"],
    )
})

test("handoff-aware compression metadata survives durable tool conversion", () => {
    const messages = fromV2SessionMessages(
        [
            {
                id: "assistant",
                type: "assistant",
                content: [
                    {
                        type: "tool",
                        id: "call",
                        name: "acp_compress",
                        state: {
                            status: "completed",
                            input: {},
                            content: "Compressed",
                            metadata: { acpHostInputRefs: true, unrelated: "ignored" },
                        },
                    },
                ],
            },
        ],
        "session",
    )
    const tool = messages[0].parts[0] as any
    assert.deepEqual(tool.state.metadata, { acpHostInputRefs: true })
})
