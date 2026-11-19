import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpV2Plugin } from "../src/v2/plugin"

// Exercise the registered boundary: the host has already lowered a durable
// synthetic delivery into a user-role model message before ACP runs.
for (const handoffOnly of [false, true]) {
    test(`the context hook preserves delivered handoffs (${handoffOnly ? "handoff-only" : "human history"})`, async () => {
        const sandbox = await mkdtemp(join(tmpdir(), "acp-v2-handoffs-"))
        const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
        const previous = keys.map((key) => process.env[key])
        for (const key of keys) process.env[key] = sandbox
        let dispose: (() => void) | undefined
        try {
            const history = [
                { id: "prompt", type: "user", text: "Wait for the worker." },
                { id: "answer", type: "assistant", content: [{ type: "text", text: "Waiting." }] },
                {
                    id: "handoff",
                    type: "synthetic",
                    text: "WORKER_RESULT_UNIQUE",
                    metadata: { source: "subagent", childID: "worker", state: "completed" },
                },
                { id: "late", type: "synthetic", text: "NOT_IN_THIS_REQUEST" },
            ]
            if (handoffOnly) history.splice(0, 2)
            let hook: ((event: any) => Promise<void>) | undefined
            const tools: any[] = []
            const storage = new Map<string, unknown>()
            const ctx = {
                location: { directory: sandbox },
                storage: {
                    get: async (key: string) => storage.get(key),
                    set: async (key: string, value: unknown) => {
                        storage.set(key, value)
                    },
                    scan: async () => [],
                },
                session: {
                    context: async () => history,
                    get: async () => ({ id: "session" }),
                    hook: async (name: string, handler: typeof hook) => {
                        if (name === "context") hook = handler
                    },
                },
                tool: {
                    transform: async (transform: any) =>
                        transform({ add: (tool: unknown) => tools.push(tool) }),
                },
                command: { transform: async () => {} },
                provider: { list: async () => [] },
                event: { subscribe: async function* () {} },
            }
            dispose = (await AcpV2Plugin.setup(ctx as never)) as typeof dispose
            assert.ok(hook)
            const handoff = {
                id: "handoff",
                role: "user",
                content: [{ type: "text", text: "WORKER_RESULT_UNIQUE" }],
                metadata: { source: "subagent", childID: "worker", state: "completed" },
            }
            const event = {
                sessionID: "session",
                agent: "code",
                model: { providerID: "provider", id: "model" },
                system: [{ type: "text", text: "System" }],
                messages: [
                    {
                        id: "prompt",
                        role: "user",
                        content: [{ type: "text", text: "Wait for the worker." }],
                    },
                    {
                        id: "answer",
                        role: "assistant",
                        content: [{ type: "text", text: "Waiting." }],
                    },
                    handoff,
                ],
            }
            if (handoffOnly) event.messages.splice(0, 2)
            await hook(event)
            const status = await tools
                .find((tool) => tool.name === "acp_status")
                .execute({ scope: "uncompressed", view: "messages" }, { sessionID: "session" })
            assert.match(status.content, handoffOnly ? /1 msgs/ : /3 msgs/)
            const wire = JSON.stringify(event.messages)
            assert.ok(
                wire.includes("WORKER_RESULT_UNIQUE"),
                "ACP must not erase a delivered worker result",
            )
            assert.ok(
                !wire.includes("NOT_IN_THIS_REQUEST"),
                "durable arrivals must not leak into an older request",
            )
            const delivered = event.messages.find((message) => message.id === "handoff")
            assert.ok(delivered)
            assert.equal(delivered.role, "user")
            assert.deepEqual(delivered.metadata, handoff.metadata)
        } finally {
            dispose?.()
            keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key]
                else process.env[key] = previous[index]
            })
            await rm(sandbox, { recursive: true, force: true })
        }
    })
}
