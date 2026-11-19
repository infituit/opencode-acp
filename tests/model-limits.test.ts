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

test("request-time catalog misses recover after the cooldown and share concurrent loads", async (t) => {
    let now = 1000
    t.mock.method(Date, "now", () => now)
    const logger = new Logger(false, "silent")
    logger.info = () => undefined
    logger.warn = () => undefined
    logger.debug = () => undefined
    const registry = new SessionStateRegistry(logger)
    let requests = 0
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
        release = resolve
    })
    const client = {
        model: {
            async list() {
                requests++
                if (requests === 1) return { data: [] }
                await pending
                return { data: models }
            },
        },
    }
    assert.equal(await registry.hydrateAndResolve(client, "provider", "large"), undefined)
    now += 29_999
    assert.equal(await registry.hydrateAndResolve(client, "provider", "large"), undefined)
    assert.equal(requests, 1)
    now++
    const large = registry.hydrateAndResolve(client, "provider", "large")
    const small = registry.hydrateAndResolve(client, "provider", "small")
    assert.equal(requests, 2)
    registry.recordModelLimit("provider", "cached", 16000)
    now += 60_000
    assert.equal(await registry.hydrateAndResolve(client, "provider", "cached"), 16000)
    const concurrent = registry.hydrateAndResolve(client, "provider", "large")
    assert.equal(requests, 2, "long in-flight loads are still shared")
    release()
    assert.deepEqual(await Promise.all([large, small, concurrent]), [272000, 64000, 272000])
    now += 29_999
    assert.equal(await registry.hydrateAndResolve(client, "provider", "absent"), undefined)
    assert.equal(requests, 2, "cooldown begins at completion, not at request start")
    now++
    assert.equal(await registry.hydrateAndResolve(client, "provider", "large"), 272000)
    assert.equal(requests, 2, "cache hits do not refresh the catalog")
    assert.equal(await registry.hydrateAndResolve(client, "provider", "absent"), undefined)
    assert.equal(requests, 3, "a continuing miss retries at the cooldown boundary")
})

test("catalog retries request errors, malformed responses and a model absent from a valid catalog", async (t) => {
    let now = 1000
    t.mock.method(Date, "now", () => now)
    const logger = new Logger(false, "silent")
    logger.info = () => undefined
    logger.warn = () => undefined
    logger.debug = () => undefined
    for (const initial of ["error", "malformed", "missing-model"]) {
        const registry = new SessionStateRegistry(logger)
        let requests = 0
        const client = {
            model: {
                async list() {
                    if (++requests > 1) return { data: models }
                    if (initial === "error") throw new Error("synthetic failure")
                    if (initial === "malformed") return { data: null }
                    return { data: [models[1]] }
                },
            },
        }
        assert.equal(await registry.hydrateAndResolve(client, "provider", "large"), undefined)
        now += 30_000
        assert.equal(await registry.hydrateAndResolve(client, "provider", "large"), 272000)
        assert.equal(requests, 2)
    }
})

test("catalog load diagnostics distinguish failure shapes without exposing response or error content", async () => {
    const logger = new Logger(false, "silent")
    const records: Array<{ reason?: string; [key: string]: unknown }> = []
    logger.info = (_, data) => {
        records.push(data as (typeof records)[number])
    }
    logger.warn = (_, data) => {
        records.push(data as (typeof records)[number])
    }
    const catalog = createModelLimitCatalog(logger)
    await catalog.hydrateFromClient({})
    await catalog.hydrateFromClient({
        model: { list: async () => ({ secret: "private-response" }) },
    })
    await catalog.hydrateFromClient({
        model: {
            list: async () => {
                throw new Error("private-error")
            },
        },
    })
    await catalog.hydrateFromClient({ model: { list: async () => ({ data: [] }) } })
    await catalog.hydrateFromClient({
        model: { list: async () => ({ data: [{ id: "no-limit" }] }) },
    })
    await catalog.hydrateFromClient({ model: { list: async () => ({ data: [...models, null] }) } })
    assert.deepEqual(
        records.map((record) => record.reason),
        [
            "api_unavailable",
            "invalid_response",
            "request_failed",
            "empty_catalog",
            "no_valid_limits",
            "loaded",
        ],
    )
    assert.deepEqual(records.at(-1), {
        reason: "loaded",
        entries: 4,
        recorded: 3,
        skipped: 1,
        catalogSize: 3,
    })
    assert.equal(JSON.stringify(records).includes("private-"), false)
})

test("message transform resolves V2 limits on the first request, switches models and preserves fallback", async (t) => {
    let now = 1000
    t.mock.method(Date, "now", () => now)
    const sandbox = await mkdtemp(join(tmpdir(), "acp-model-limits-test-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    try {
        const logger = new Logger(false, "silent")
        const completed: Array<Record<string, unknown>> = []
        const warnings: Array<{ message: string; data: Record<string, unknown> }> = []
        logger.debug = () => undefined
        logger.warn = (message, data) => {
            warnings.push({ message, data })
        }
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
        let catalogModels = models
        const client = {
            model: {
                async list() {
                    requests++
                    return { location: { directory: sandbox }, data: catalogModels }
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
        assert.equal(warnings.length, 1)
        assert.match(warnings[0].message, /using compress.contextLimitFallback/)
        assert.doesNotMatch(warnings[0].message, /guard are disabled/)
        assert.equal(warnings[0].data.contextLimit, 128000)
        assert.equal(warnings[0].data.contextLimitSource, "fallback")
        config.compress.contextLimitFallback = 0
        state.noContextLimitWarned = false
        const unknownMessages = fromV2SessionMessages(
            [{ id: "user-unknown", type: "user", text: "Unknown model", time: { created: 200 } }],
            "session",
        )
        if (unknownMessages[0].info.role !== "user") throw new Error("Expected user fixture")
        unknownMessages[0].info.model = { providerID: "provider", modelID: "unknown" }
        await handler({}, { messages: unknownMessages })
        assert.equal(resolveEffectiveContextLimit(state, config), undefined)
        assert.match(warnings.at(-1)!.message, /contextLimitFallback is disabled/)
        assert.equal(warnings.at(-1)!.data.contextLimitSource, "unknown")
        catalogModels = [
            ...models,
            { providerID: "provider", id: "unknown", limit: { context: 96000 } },
        ]
        now += 30_000
        await handler({}, { messages: unknownMessages })
        assert.deepEqual(resolveEffectiveContextLimit(state, config), {
            limit: 96000,
            source: "model",
        })
        assert.equal(completed.at(-1)?.contextLimit, 96000)
        assert.equal(completed.at(-1)?.contextLimitSource, "model")
        assert.equal(warnings.length, 2, "recovery does not produce another missing-limit warning")
        assert.equal(requests, 2)
    } finally {
        keys.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key]
            else process.env[key] = previous[i]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})
