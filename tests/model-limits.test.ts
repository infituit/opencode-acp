import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelLimitCatalog } from "../src/state/model-limits"
import { createSessionState, SessionStateRegistry } from "../src/state"
import { resolveEffectiveContextLimit } from "../src/state/utils"
import { createChatMessageTransformHandler } from "../src/v2/hooks"
import { fromV2SessionMessages } from "../src/v2/messages"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { PromptStore } from "../src/prompts/store"

const models = [
    { providerID: "provider", id: "large", limit: { context: 272000 } },
    { providerID: "provider", id: "small", limit: { context: 64000 } },
    { providerID: "other", id: "large", limit: { context: 32000 } },
]

test("model catalog reads V2 data and keeps valid entries when other entries are malformed", async () => {
    const catalog = createModelLimitCatalog()
    const recorded = await catalog.hydrateFromClient({
        model: {
            async list() {
                return {
                    location: { directory: "/synthetic" },
                    data: [
                        null,
                        ...models,
                        undefined,
                        {},
                        { providerID: "provider", id: "zero", limit: { context: 0 } },
                        { providerID: "provider", id: "negative", limit: { context: -1 } },
                        { providerID: "provider", id: "string", limit: { context: "128000" } },
                    ],
                }
            },
        },
    })
    assert.equal(recorded, models.length)
    for (const model of models) {
        assert.equal(catalog.resolve(model.providerID, model.id), model.limit.context)
    }
    for (const id of ["zero", "negative", "string", "unknown"]) {
        assert.equal(catalog.resolve("provider", id), undefined)
    }
})

test("failed or malformed V2 catalog responses do not throw or erase existing limits", async () => {
    const catalog = createModelLimitCatalog()
    catalog.record("provider", "known", 128000)
    for (const response of [undefined, null, {}, { data: null }, { data: {} }, { data: [] }]) {
        assert.equal(await catalog.hydrateFromClient({ model: { list: async () => response } }), 0)
        assert.equal(catalog.resolve("provider", "known"), 128000)
    }
    assert.equal(
        await catalog.hydrateFromClient({
            model: {
                async list() {
                    throw new Error("synthetic catalog failure")
                },
            },
        }),
        0,
    )
    assert.equal(await catalog.hydrateFromClient({}), 0)
    assert.equal(catalog.resolve("provider", "known"), 128000)
})

test("message transform resolves V2 limits on the first request, switches models and preserves fallback", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-model-limits-test-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    try {
        const logger = new Logger(false, "silent")
        const completed: Array<Record<string, unknown>> = []
        logger.debug = () => undefined
        logger.warn = () => undefined
        logger.error = () => undefined
        logger.info = (message, data) => {
            if (message === "Chat transform complete" && data) completed.push(data)
        }
        logger.saveContext = async () => undefined
        const config = getConfig({ directory: sandbox })
        config.compress.images.enabled = false
        config.compress.maxContextLimit = Number.MAX_SAFE_INTEGER
        config.compress.minContextLimit = Number.MAX_SAFE_INTEGER
        config.compress.iterationNudgeThreshold = Number.MAX_SAFE_INTEGER
        assert.equal(config.compress.emergencyTruncation, false)
        const state = createSessionState()
        state.storageDir = sandbox
        const registry = new SessionStateRegistry(logger, sandbox)
        registry.getOrCreate = async () => state
        let requests = 0
        const client = {
            model: {
                async list() {
                    requests++
                    return { location: { directory: sandbox }, data: models }
                },
            },
        }
        const handler = createChatMessageTransformHandler(
            client,
            registry,
            logger,
            config,
            new PromptStore(logger, sandbox),
            { global: undefined, agents: {} },
        )
        for (const [providerID, id, limit, source] of [
            ["provider", "large", 272000, "model"],
            ["provider", "small", 64000, "model"],
            ["other", "large", 32000, "model"],
            ["provider", "unknown", 128000, "fallback"],
        ] as const) {
            const messages = fromV2SessionMessages(
                [{ id: "user", type: "user", text: "Synthetic request", time: { created: 100 } }],
                "session",
            )
            if (messages[0].info.role !== "user") throw new Error("Expected user fixture")
            messages[0].info.model = { providerID, modelID: id }
            await handler({}, { messages })
            assert.deepEqual(resolveEffectiveContextLimit(state, config), { limit, source })
            assert.equal(completed.at(-1)?.contextLimit, limit)
            assert.equal(completed.at(-1)?.contextLimitSource, source)
            assert.equal(requests, 1, "requests reuse the existing registry hydration")
        }
        config.compress.contextLimitFallback = 0
        assert.equal(resolveEffectiveContextLimit(state, config), undefined)
    } finally {
        keys.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key]
            else process.env[key] = previous[i]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})
