import assert from "node:assert/strict"
import { test } from "node:test"
import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

test("background notices do not admit session input", { timeout: 10000 }, async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-background-notices-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    const { getConfig } = await import("../src/config")
    const { Logger } = await import("../src/logger")
    const { createSessionState } = await import("../src/state")
    const { configureNativeStateStorage } = await import("../src/state/persistence")
    const { finalizeSession } = await import("../src/compress/pipeline")
    const { AcpV2Plugin } = await import("../src/v2/plugin")
    const { sendIgnoredMessage } = await import("../src/ui/notification")
    const logs: Array<{ level: string; message: string; data?: any }> = []
    for (const level of ["info", "warn", "error"] as const) {
        t.mock.method(Logger.prototype, level, (message: string, data?: unknown) => {
            logs.push({ level, message, data })
            return Promise.resolve()
        })
    }
    t.after(async () => {
        configureNativeStateStorage(undefined)
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key]
            else process.env[key] = previous[index]
        })
        await rm(sandbox, { recursive: true, force: true })
    })
    const configDir = join(sandbox, ".opencode")
    await mkdir(configDir)
    const configPath = join(configDir, "acp.json")
    const logger = new Logger(false, "info")

    await t.test("configuration warnings log without looking up any session", async () => {
        const commands: any[] = []
        const storage = new Map<string, any>()
        const ctx = {
            location: { directory: sandbox },
            storage: {
                get: async (key: string) => storage.get(key),
                set: async (key: string, value: unknown) => storage.set(key, value),
                scan: async () => ({ entries: [] }),
            },
            model: { list: async () => ({ data: [] }) },
            command: {
                transform: async (edit: any) => edit({ add: (c: any) => commands.push(c) }),
            },
            tool: { transform: async () => {} },
            session: {
                hook: async () => {},
                list: async () => assert.fail("Global warnings must not select a session"),
                synthetic: async () => assert.fail("Background notices must not admit input"),
            },
            event: { subscribe: async function* () {} },
        }
        await writeFile(configPath, JSON.stringify({ autoUpdate: false, unknownSetting: true }))
        const cleanup = await AcpV2Plugin.setup(ctx as never)
        if (typeof cleanup === "function") await cleanup()
        assert.equal(commands.length, 1, "the explicit command remains registered")
        assert.ok(
            logs.some(
                (e) => e.level === "warn" && /Unknown keys: unknownSetting/.test(e.data?.message),
            ),
        )

        // A disabled plugin still reports invalid configuration without loading
        // session APIs. Parse warnings use the same immediate logging path.
        await writeFile(configPath, JSON.stringify({ enabled: false, anotherUnknown: true }))
        await AcpV2Plugin.setup({ location: ctx.location } as never)
        assert.ok(logs.some((e) => e.level === "warn" && /anotherUnknown/.test(e.data?.message)))
        const warnings: string[] = []
        await writeFile(configPath, "null")
        getConfig({
            directory: sandbox,
            notify: async (title) => {
                warnings.push(title)
            },
        })
        assert.ok(warnings.some((title) => title.startsWith("ACP: Invalid")))
        await writeFile(configPath, JSON.stringify({ autoUpdate: false }))
    })

    await t.test(
        "completion persists state without a client for every legacy display mode",
        async () => {
            const storage = new Map<string, any>()
            configureNativeStateStorage({
                get: async (key) => storage.get(key),
                set: async (key, value) => {
                    storage.set(key, structuredClone(value))
                },
            })
            const config = getConfig({ directory: sandbox })
            config.qualityGate.enabled = false
            const state = createSessionState()
            state.sessionId = "background-session"
            state.prune.messages.blocksById.set(1, {
                blockId: 1,
                runId: 1,
                active: true,
                deactivatedByUser: false,
                compressedTokens: 100,
                effectiveCompressedTokens: 120,
                summaryTokens: 10,
                durationMs: 0,
                topic: "Saved work",
                startId: "m00001",
                endId: "m00002",
                anchorMessageId: "anchor",
                compressMessageId: "compress",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [],
                effectiveToolIds: [],
                createdAt: 1,
                summary: "Saved summary",
                survivedCount: 0,
            })
            state.prune.messages.activeBlockIds.add(1)
            const entry = { blockId: 1, runId: 1, summary: "Saved summary", summaryTokens: 10 }
            for (const mode of ["off", "minimal", "detailed"] as const) {
                for (const destination of ["chat", "toast"] as const) {
                    config.pruneNotification = mode
                    config.pruneNotificationType = destination
                    await finalizeSession(
                        { client: undefined, state, logger, config } as any,
                        { sessionID: state.sessionId },
                        [],
                        [entry],
                        undefined,
                    )
                    const event = logs.filter((e) => e.message === "Compression completed").at(-1)
                    assert.deepEqual(event?.data, {
                        sessionId: state.sessionId,
                        blockIds: [1],
                        topics: ["Saved work"],
                        compressedTokens: 120,
                        summaryTokens: 10,
                        contextTokensBefore: 0,
                    })
                    assert.equal(
                        storage.get("sessions/background-session").prune.messages.blocksById["1"]
                            .summary,
                        "Saved summary",
                    )
                }
            }
            const count = logs.filter((e) => e.message === "Compression completed").length
            await finalizeSession(
                { client: undefined, state, logger, config } as any,
                { sessionID: state.sessionId },
                [],
                [],
                undefined,
            )
            assert.equal(logs.filter((e) => e.message === "Compression completed").length, count)
        },
    )

    await t.test("legacy display preferences do not alter model context reminders", async (t) => {
        t.mock.method(Date, "now", () => 1000)
        const { injectCompressNudges } = await import("../src/messages/inject/inject")
        const { fromV2SessionMessages } = await import("../src/v2/messages")
        const { PromptStore } = await import("../src/prompts/store")
        const config = getConfig({ directory: sandbox })
        const prompts = new PromptStore(logger, sandbox).getRuntimePrompts()
        let baseline: unknown
        for (const mode of ["off", "minimal", "detailed"] as const) {
            for (const destination of ["chat", "toast"] as const) {
                config.pruneNotification = mode
                config.pruneNotificationType = destination
                const messages = fromV2SessionMessages(
                    [{ id: "request", type: "user", text: "Continue the work", createdAt: 100 }],
                    "model-session",
                )
                const state = createSessionState()
                state.modelContextLimit = 1
                await injectCompressNudges(state, config, logger, messages, prompts)
                assert.ok(messages.length > 1, "the model context suffix must remain present")
                if (baseline === undefined) baseline = structuredClone(messages)
                else assert.deepEqual(messages, baseline)
            }
        }
    })

    await t.test(
        "an applied update logs its restart notice without a delayed session delivery",
        async () => {
            // Exercise the real updater against a disposable installed wrapper.
            // Only the registry response is local; package removal stays in sandbox.
            const wrapper = join(sandbox, "update-wrapper")
            const packageDir = join(wrapper, "node_modules", "@infituit", "opencode-acp")
            await mkdir(packageDir, { recursive: true })
            await writeFile(
                join(wrapper, "package.json"),
                JSON.stringify({
                    dependencies: { "@infituit/opencode-acp": "stable" },
                }),
            )
            await writeFile(
                join(packageDir, "package.json"),
                JSON.stringify({
                    name: "@infituit/opencode-acp",
                    version: "2.0.0-alpha.16",
                    type: "module",
                }),
            )
            const modulePath = join(packageDir, "update.ts")
            await copyFile(new URL("../src/update.ts", import.meta.url), modulePath)
            const request = Promise.withResolvers<void>()
            t.mock.method(globalThis, "fetch", async (url) => {
                assert.equal(url, "https://registry.npmjs.org/%40infituit%2Fopencode-acp/stable")
                request.resolve()
                return new Response(JSON.stringify({ version: "2.0.0-alpha.17" }))
            })
            const { startAutoUpdate } = await import(pathToFileURL(modulePath).href)
            const delivered = Promise.withResolvers<{ title: string; message: string }>()
            startAutoUpdate(
                {
                    notify: async (title: string, message: string) => {
                        await logger.info(title, { message })
                        delivered.resolve({ title, message })
                    },
                },
                true,
                logger,
            )
            await request.promise
            const notice = await delivered.promise
            assert.equal(notice.title, "ACP update ready")
            assert.match(
                notice.message,
                /from 2\.0\.0-alpha\.16 to 2\.0\.0-alpha\.17\. Restart OpenCode/,
            )
            assert.ok(
                logs.some((e) => e.message === notice.title && e.data?.message === notice.message),
            )
            await assert.rejects(access(wrapper), { code: "ENOENT" })
        },
    )

    await t.test("explicit command feedback keeps the existing synthetic contract", async () => {
        const admitted: unknown[] = []
        await sendIgnoredMessage(
            { session: { synthetic: async (input: unknown) => admitted.push(input) } },
            "requested-session",
            "Command result",
            {},
            logger,
        )
        assert.deepEqual(admitted, [
            {
                sessionID: "requested-session",
                text: "Command result",
                description: "ACP",
                metadata: { source: "opencode-acp" },
            },
        ])
    })

    await t.test(
        "schema explains legacy display settings without changing their accepted values",
        async () => {
            const schema = JSON.parse(
                await readFile(new URL("../acp.schema.json", import.meta.url), "utf8"),
            )
            assert.deepEqual(schema.properties.pruneNotification.enum, [
                "off",
                "minimal",
                "detailed",
            ])
            assert.deepEqual(schema.properties.pruneNotificationType.enum, ["chat", "toast"])
            assert.match(
                schema.properties.pruneNotification.description,
                /does not affect model context reminders/,
            )
        },
    )
})
