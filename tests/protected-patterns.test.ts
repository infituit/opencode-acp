import assert from "node:assert/strict"
import { test } from "node:test"
import { getFilePathsFromParameters, isFilePathProtected } from "../src/protected-patterns"
import {
    appendProtectedTools,
    filterProtectedToolMessages,
    messageContainsProtectedTool,
} from "../src/compress/protected-content"
import { buildSearchContext } from "../src/compress/search"
import type { SelectionResolution } from "../src/compress/types"
import { buildCompressibleRanges } from "../src/messages/inject/utils"
import { createSessionState } from "../src/state"
import { fromV2SessionMessages } from "../src/v2/messages"

for (const tool of ["read", "write", "edit"]) {
    test(`${tool} extracts V2 path and existing filePath parameters`, () => {
        assert.deepEqual(getFilePathsFromParameters(tool, { path: "AGENTS.md" }), ["AGENTS.md"])
        assert.deepEqual(getFilePathsFromParameters(tool, { filePath: "AGENTS.md" }), ["AGENTS.md"])
        assert.deepEqual(
            getFilePathsFromParameters(tool, { path: "AGENTS.md", filePath: "AGENTS.md" }),
            ["AGENTS.md"],
        )
        assert.deepEqual(
            getFilePathsFromParameters(tool, { path: "other.md", filePath: "AGENTS.md" }),
            ["AGENTS.md", "other.md"],
        )
    })
}

const patchText = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export const value = 1",
    "*** Update File: docs/old.md",
    "*** Move to: docs/AGENTS.md",
    "@@",
    "-old",
    "+new",
    "+*** Delete File: not-a-header.md",
    "*** Delete File: src/removed.ts",
    "*** End Patch",
].join("\n")

for (const tool of ["patch", "apply_patch"]) {
    test(`${tool} extracts add, update, move destination and delete paths`, () => {
        for (const text of [patchText, patchText.replaceAll("\n", "\r\n")]) {
            const paths = getFilePathsFromParameters(tool, { patchText: text })
            assert.deepEqual(paths, [
                "src/new.ts",
                "docs/old.md",
                "docs/AGENTS.md",
                "src/removed.ts",
            ])
            assert.equal(isFilePathProtected(paths, ["**/AGENTS.md"]), true)
            assert.equal(isFilePathProtected(paths, ["**/old.md"]), true)
            assert.equal(isFilePathProtected(paths, ["not-a-header.md"]), false)
        }
        assert.deepEqual(
            getFilePathsFromParameters(tool, {
                patchText: "*** Update File: AGENTS.md\n*** Move to: AGENTS.md\n*** Add File:   ",
            }),
            ["AGENTS.md"],
        )
    })
}

test("multiedit retains top-level and nested file paths without duplicates", () => {
    assert.deepEqual(
        getFilePathsFromParameters("multiedit", {
            filePath: "first.ts",
            path: "second.ts",
            edits: [null, { filePath: "first.ts" }, { filePath: "third.ts" }],
        }),
        ["first.ts", "third.ts", "second.ts"],
    )
})

test("invalid inputs and unrelated text do not become protected paths", () => {
    for (const parameters of [undefined, null, "AGENTS.md", 1, [], { path: 1, filePath: null }]) {
        assert.deepEqual(getFilePathsFromParameters("read", parameters), [])
    }
    assert.deepEqual(getFilePathsFromParameters("patch", { patchText: null }), [])
    assert.deepEqual(getFilePathsFromParameters("shell", { command: patchText }), [])
    assert.deepEqual(getFilePathsFromParameters("read", { text: "AGENTS.md" }), [])
    assert.deepEqual(getFilePathsFromParameters("read", { path: "", filePath: "" }), [])
    assert.equal(isFilePathProtected(["src/regular.ts"], ["**/AGENTS.md"]), false)
    assert.equal(isFilePathProtected(["AGENTS.md"], []), false)
    assert.equal(isFilePathProtected(["C:\\repo\\AGENTS.md"], ["**/AGENTS.md"]), true)
})

for (const [tool, input] of [
    ["read", { path: "AGENTS.md" }],
    ["write", { path: "docs/AGENTS.md", content: "rules" }],
    ["edit", { path: "AGENTS.md", oldString: "old", newString: "new" }],
    ["patch", { patchText }],
] as const) {
    test(`V2 ${tool} file protection reaches filtering, range guidance and summary preservation`, async () => {
        const messages = fromV2SessionMessages(
            [
                {
                    id: "assistant",
                    type: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: "protected",
                            name: tool,
                            input,
                            result: "protected output",
                        },
                    ],
                },
                {
                    id: "other",
                    type: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: "ordinary",
                            name: "read",
                            input: { path: "src/main.ts" },
                            result: "ordinary output",
                        },
                    ],
                },
            ],
            "session",
        )
        const state = createSessionState()
        state.messageIds.byRawId.set("assistant", "m00001")
        state.messageIds.byRawId.set("other", "m00002")
        const search = buildSearchContext(state, messages)
        const selection: SelectionResolution = {
            startReference: { kind: "message", rawIndex: 0, messageId: "assistant" },
            endReference: { kind: "message", rawIndex: 1, messageId: "other" },
            messageIds: ["assistant", "other"],
            messageTokenById: new Map([
                ["assistant", 10],
                ["other", 20],
            ]),
            toolIds: ["protected", "ordinary"],
            requiredBlockIds: [],
        }
        const patterns = ["**/AGENTS.md"]
        assert.equal(messageContainsProtectedTool(messages[0], [], patterns), true)
        assert.equal(messageContainsProtectedTool(messages[1], [], patterns), false)
        assert.equal(messageContainsProtectedTool(messages[0], [], []), false)
        const filtered = filterProtectedToolMessages(selection, search, [], patterns)
        assert.deepEqual(filtered.messageIds, ["other"])
        assert.deepEqual(filtered.toolIds, ["ordinary"])
        assert.deepEqual([...filtered.messageTokenById], [["other", 20]])
        assert.deepEqual(selection.messageIds, ["assistant", "other"])
        assert.equal(filterProtectedToolMessages(selection, search, [], []), selection)
        const ranges = buildCompressibleRanges(messages, state, [], patterns)
        assert.deepEqual(
            ranges.protected.map(({ startRef, tools }) => ({ startRef, tools })),
            [{ startRef: "m00001", tools: [tool] }],
        )
        assert.equal(ranges.compressible[0].startRef, "m00002")
        const summary = await appendProtectedTools(
            {},
            state,
            "summary",
            selection,
            search,
            [],
            patterns,
        )
        assert.match(summary, /protected output/)
        assert.doesNotMatch(summary, /ordinary output/)
        assert.equal(
            await appendProtectedTools({}, state, "summary", selection, search, [], []),
            "summary",
        )
    })
}
