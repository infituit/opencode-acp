import assert from "node:assert/strict"
import { test } from "node:test"
import { Media } from "@opencode/ai/media"
import { createRequire } from "node:module"
import { lowerConversation } from "@opencode/ai/protocols/open-responses"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { archiveSessionImages, appendArchivedImagePointers } from "../src/compress/image-archive"
import { createSessionState } from "../src/state"
import type { SelectionResolution } from "../src/compress/types"
import { Logger } from "../src/logger"
import { prune } from "../src/messages/prune"
import type { PluginConfig } from "../src/config"
import { AcpV2Plugin } from "../src/v2/plugin"
import { fromV2SessionMessages, toV2RequestMessages } from "../src/v2/messages"

const { Effect } = createRequire(import.meta.resolve("@opencode/ai"))("effect")

const image = {
    type: "file",
    uri: "data:image/png;base64,AQID",
    mime: "image/png",
    name: "shot.png",
}
const document = { type: "file", uri: "JVBERg==", mime: "application/pdf", name: "report.pdf" }

function toolHistory(content: unknown) {
    return [
        {
            id: "assistant",
            type: "assistant",
            content: [
                {
                    type: "tool",
                    id: "call",
                    name: "read",
                    state: { status: "completed", input: { path: "shot.png" }, content },
                },
            ],
        },
    ]
}

function result(messages: ReturnType<typeof fromV2SessionMessages>): any {
    const wire = toV2RequestMessages(messages) as any[]
    assert.deepEqual(wire[0].content[0], {
        type: "tool-call",
        id: "call",
        name: "read",
        input: { path: "shot.png" },
    })
    assert.equal(wire[1].role, "tool")
    assert.equal(wire[1].content[0].id, "call")
    return wire[1].content[0].result
}

test("tool images and documents remain structured content in their original order", () => {
    const content = [
        { type: "text", text: "before" },
        image,
        { type: "text", text: "after" },
        document,
    ]
    const history = toolHistory(content)
    const messages = fromV2SessionMessages(history, "session")
    assert.equal(messages[0].parts[0].state.output, "before\nafter")
    assert.deepEqual(result(messages), { type: "content", value: content })
    assert.deepEqual(history[0].content[0].state.content, content)
})

test("modified tool text is not restored from its original multimodal content", () => {
    const messages = fromV2SessionMessages(
        toolHistory([{ type: "text", text: "ORIGINAL" }, image]),
        "session",
    )
    messages[0].parts[0].state.output = "TRUNCATED"
    assert.deepEqual(result(messages), {
        type: "content",
        value: [{ type: "text", text: "TRUNCATED" }, image],
    })
})

test("cleared tool results do not resurrect their original media", () => {
    const messages = fromV2SessionMessages(toolHistory([image]), "session")
    messages[0].parts[0].state.output = "[Old tool result content cleared]"
    assert.deepEqual(result(messages), { type: "text", value: "[Old tool result content cleared]" })
})

test("text-only and error results retain their wire shape", () => {
    const history = toolHistory([{ type: "text", text: "hello" }])
    assert.deepEqual(result(fromV2SessionMessages(history, "session")), {
        type: "text",
        value: "hello",
    })
    history[0].content[0].state.status = "error"
    assert.deepEqual(result(fromV2SessionMessages(history, "session")), {
        type: "error",
        value: "hello",
    })
})

test("host media retains its exact asset instance while text stays independently mutable", () => {
    const asset = Media.base64("AQID", "image/png")
    const media = { type: "media", media: asset, filename: "shot.png" }
    const request = [{ id: "user", role: "user", content: [{ type: "text", text: "Look" }, media] }]
    const history = [
        {
            id: "user",
            type: "user",
            text: "Look",
            files: [{ data: "AQID", mime: "image/png", source: { type: "inline" } }],
        },
    ]
    const messages = fromV2SessionMessages(history, "session", request)
    messages[0].parts[0].text = "ACP Look"
    const wire = toV2RequestMessages(messages) as any[]
    assert.equal(wire[0].content[1].media, asset)
    assert.deepEqual(wire[0].content[1].media.inline(), asset.inline())
    assert.equal(wire[0].content[0].text, "ACP Look")
    assert.equal(request[0].content[0].text, "Look")
})

test("synthetic host deliveries preserve media assets rather than structured-cloning them", () => {
    const asset = Media.base64("AQID", "image/png")
    const request = [{ id: "delivery", role: "user", content: [{ type: "media", media: asset }] }]
    const messages = fromV2SessionMessages(
        [{ id: "delivery", type: "synthetic", text: "delivery" }],
        "session",
        request,
    )
    const wire = toV2RequestMessages(messages) as any[]
    assert.equal(wire[0].content[0].media, asset)
    assert.equal(wire[0].id, "delivery")
})

async function lower(messages: unknown[]) {
    return Effect.runPromise(
        lowerConversation(
            {
                model: { id: "model", provider: "test", route: {} },
                system: [],
                messages,
            } as never,
            { id: "open-responses", name: "test" } as never,
        ),
    ) as Promise<any>
}

test("the provider receives native image/file items rather than base64 text", async () => {
    const messages = fromV2SessionMessages(
        toolHistory([{ type: "text", text: "Look" }, image, document]),
        "session",
    )
    const body = await lower(toV2RequestMessages(messages))
    assert.equal(body.input[0].type, "function_call")
    assert.equal(body.input[1].type, "function_call_output")
    assert.deepEqual(body.input[1].output, [
        { type: "input_text", text: "Look" },
        { type: "input_image", image_url: image.uri, detail: undefined },
        {
            type: "input_file",
            filename: "report.pdf",
            detail: undefined,
            file_data: "data:application/pdf;base64,JVBERg==",
        },
    ])
    const asset = Media.base64("AQID", "image/png")
    const request = [{ id: "user", role: "user", content: [{ type: "media", media: asset }] }]
    const users = fromV2SessionMessages(
        [{ id: "user", type: "user", text: "" }],
        "session",
        request,
    )
    const userBody = await lower(toV2RequestMessages(users))
    assert.equal(userBody.input[0].content[0].image_url, image.uri)
})

test("message-ID suffixes preserve tool media order and appear only once", () => {
    const content = [{ type: "text", text: "before" }, image, { type: "text", text: "after" }]
    const messages = fromV2SessionMessages(toolHistory(content), "session")
    messages[0].parts[0].state.output += "<message-ref>m00001</message-ref>"
    assert.deepEqual(result(messages), {
        type: "content",
        value: [...content, { type: "text", text: "<message-ref>m00001</message-ref>" }],
    })
})

for (const source of [
    Media.bytes(new Uint8Array([1, 2, 3]), "image/png"),
    Media.url("https://example.com/shot.png", { mediaType: "image/png" }),
    Media.ref("openai", "file_host", "application/pdf"),
]) {
    test(`host ${source.source.type} assets keep identity and filename`, () => {
        const native = {
            type: "media",
            media: source,
            filename: "file",
            metadata: { marker: true },
        }
        const messages = fromV2SessionMessages([{ id: "u", type: "user", text: "" }], "session", [
            { id: "u", role: "user", content: [native] },
        ])
        const wire = toV2RequestMessages(messages) as any[]
        assert.equal(wire[0].content[0], native)
        assert.equal(wire[0].content[0].media, source)
        assert.equal(wire[0].content[0].filename, "file")
    })
}

test("compressed user media does not return through the native part mapping", () => {
    const asset = Media.base64("AQID", "image/png")
    const history = [
        { id: "first", type: "user", text: "task" },
        { id: "image", type: "user", text: "" },
        { id: "last", type: "user", text: "next" },
    ]
    const messages = fromV2SessionMessages(history, "session", [
        { id: "image", role: "user", content: [{ type: "media", media: asset }] },
    ])
    const state = createSessionState()
    state.prune.messages.byMessageId.set("image", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    prune(state, new Logger(false, "silent"), {} as PluginConfig, messages)
    assert.ok(!JSON.stringify(toV2RequestMessages(messages)).includes("AQID"))
})

test("host attachment projection controls order and deduplication, not durable file indices", () => {
    const asset = Media.base64("AQID", "image/png")
    const request = [
        {
            id: "user",
            role: "user",
            content: [
                { type: "text", text: "decoded text attachment" },
                { type: "text", text: "Attached file: /shot.png" },
                { type: "media", media: asset },
            ],
        },
    ]
    const history = [
        {
            id: "user",
            type: "user",
            text: "",
            files: [
                { mime: "text/plain", data: "dGV4dA==" },
                { mime: "image/png", data: "AQID" },
                { mime: "image/png", data: "AQID" },
            ],
        },
    ]
    const messages = fromV2SessionMessages(history, "session", request)
    assert.equal(messages[0].parts.filter((part) => part.type === "file").length, 1)
    assert.deepEqual((toV2RequestMessages(messages) as any[])[0].content, request[0].content)
})

test("durable URI-backed attachments archive their actual inline bytes", () => {
    const messages = fromV2SessionMessages(
        [
            {
                id: "user",
                type: "user",
                text: "",
                files: [
                    {
                        data: "AQID",
                        mime: "image/png",
                        source: { type: "uri", uri: "file:///different.png" },
                    },
                ],
            },
        ],
        "session",
    )
    assert.equal(messages[0].parts.find((part) => part.type === "file").url, image.uri)
})

test("the registered context hook preserves media through filtering, refs and prompt injection", async () => {
    const sandbox = await mkdtemp("/tmp/opencode/acp-media-hook-")
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    let dispose: (() => void) | undefined
    try {
        const asset = Media.bytes(new Uint8Array([1, 2, 3]), "image/png")
        const history = [
            {
                id: "prompt",
                type: "user",
                text: "Look",
                files: [{ data: "AQID", mime: "image/png" }],
            },
            ...toolHistory([{ type: "text", text: "Screenshot" }, image]),
            { id: "followup", type: "user", text: "Explain" },
        ]
        let hook: ((event: any) => Promise<void>) | undefined
        const ctx = {
            location: { directory: sandbox },
            storage: { get: async () => undefined, set: async () => {}, scan: async () => [] },
            session: {
                context: async () => history,
                get: async () => ({ id: "session" }),
                hook: async (name: string, handler: typeof hook) => {
                    if (name === "context") hook = handler
                },
            },
            tool: { transform: async () => {} },
            command: { transform: async () => {} },
            provider: { list: async () => [] },
            event: { subscribe: async function* () {} },
        }
        dispose = (await AcpV2Plugin.setup(ctx as never)) as typeof dispose
        assert.ok(hook)
        const event: any = {
            sessionID: "session",
            agent: "code",
            model: { providerID: "provider", id: "model" },
            system: [{ type: "text", text: "System" }],
            messages: [
                {
                    id: "prompt",
                    role: "user",
                    content: [
                        { type: "text", text: "Look" },
                        { type: "media", media: asset },
                    ],
                },
                { id: "followup", role: "user", content: [{ type: "text", text: "Explain" }] },
            ],
        }
        await hook(event)
        const user = event.messages.find((message: any) =>
            message.content.some((part: any) => part.type === "media"),
        )
        assert.equal(user.content.find((part: any) => part.type === "media").media, asset)
        const tool = event.messages.find((message: any) => message.role === "tool").content[0]
        assert.equal(tool.result.type, "content")
        assert.equal(tool.result.value.filter((part: any) => part.type === "file").length, 1)
        assert.ok(
            tool.result.value
                .filter((part: any) => part.type === "text")
                .some((part: any) => part.text.includes("Screenshot")),
        )
        const body = await lower(event.messages)
        assert.ok(
            body.input.some(
                (item: any) =>
                    item.type === "function_call_output" &&
                    item.output.some((part: any) => part.type === "input_image"),
            ),
        )
    } finally {
        dispose?.()
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key]
            else process.env[key] = previous[index]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})

test("image archiving covers user and tool images without changing its persisted index", async () => {
    const sandbox = await mkdtemp("/tmp/opencode/acp-media-")
    try {
        const state = createSessionState()
        state.sessionId = "session"
        state.storageDir = sandbox
        const images = { enabled: true, minBytes: 1, ttlDays: 7 }
        const logger = new Logger(false, "silent")
        const user = fromV2SessionMessages(
            [{ id: "user", type: "user", text: "", files: [{ data: "AQID", mime: "image/png" }] }],
            "session",
        )
        const tools = fromV2SessionMessages(
            toolHistory([
                image,
                { ...image, uri: "BAUG" },
                document,
                { ...image, uri: "https://example.com/remote.png" },
                { ...image, mime: "image/svg+xml", uri: "data:image/svg+xml;base64,AQID" },
                { ...image, mime: "image/png", uri: "data:image/svg+xml;base64,PHN2Zy8+" },
                { ...image, mime: "image/png", uri: "DATA:image/svg+xml;base64,PHN2Zy8+" },
                { ...image, mime: "image/png", uri: "data:application/pdf;base64,JVBERg==" },
            ]),
            "session",
        )
        const messages = [...user, ...tools]
        assert.equal(archiveSessionImages(state, messages, images, logger), 3)
        assert.equal(archiveSessionImages(state, messages, images, logger), 0)
        assert.equal(state.imageArchive.user.length, 1)
        assert.equal(state.imageArchive.assistant.length, 2)
        const entries = [...state.imageArchive.user, ...state.imageArchive.assistant]
        assert.deepEqual([...(await readFile(entries[0].path))], [1, 2, 3])
        assert.deepEqual([...(await readFile(entries[2].path))], [4, 5, 6])
        for (const entry of entries) {
            assert.deepEqual(Object.keys(entry).sort(), ["bytes", "mediaType", "path"])
            assert.equal((await stat(entry.path)).mode & 0o777, 0o600)
        }
        const selection = { messageIds: ["user", "assistant"] } as SelectionResolution
        const summary = appendArchivedImagePointers("summary", selection, state, true)
        for (const entry of entries) assert.ok(summary.includes(entry.path))
        assert.ok(!summary.includes("base64"))
        assert.equal(
            archiveSessionImages(state, messages, { ...images, enabled: false }, logger),
            0,
        )
    } finally {
        await rm(sandbox, { recursive: true, force: true })
    }
})
