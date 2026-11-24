import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getConfig } from "../src/config"
import { Logger } from "../src/logger"
import { createSessionState, SessionStateRegistry } from "../src/state"
import {
    configureNativeStateStorage,
    getDefaultStorageDir,
    readRecoveryState,
    rollbackForkRecovery,
    saveSessionState,
    snapshotSessionState,
    withSessionRecovery,
    writeRecoveryState,
    type PersistedSessionState,
} from "../src/state/persistence"
import { applyForkRecovery, prepareForkRecovery } from "../src/state/fork-recovery"
import { rebuildCompressionState } from "../src/state/rebuild"
import { handleRecoverForkCommand } from "../src/commands/recover-fork"
import { createCommandExecuteHandler } from "../src/v2/hooks"
import { fromV2SessionMessages } from "../src/v2/messages"

async function fixture(t: TestContext, customStorage = false) {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-recover-fork-command-"))
    const keys = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    const storage = new Map<string, unknown>()
    let nativeSets = 0
    let failNativeSet: "before" | "after" | undefined
    configureNativeStateStorage({
        get: async (key) => structuredClone(storage.get(key)),
        set: async (key, value) => {
            nativeSets++
            if (failNativeSet === "before") throw new Error("Native set failed before commit")
            storage.set(key, structuredClone(value))
            if (failNativeSet === "after") throw new Error("Native set failed after commit")
        },
    })
    t.after(async () => {
        configureNativeStateStorage(undefined)
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key]
            else process.env[key] = previous[index]
        })
        await rm(sandbox, { recursive: true, force: true })
    })
    const logger = new Logger(false, "silent")
    const config = getConfig({ directory: sandbox })
    config.storagePath = customStorage ? "state" : undefined
    config.compress.protectedTools = ["acp_compress"]
    config.protectedFilePatterns = []
    config.compress.minCompressRange = 0
    config.compress.preserveLastUserMessage = false
    config.compress.preserveRecentMessages = 0
    config.compress.preserveRecentTokens = 0
    const storageDir = customStorage ? join(sandbox, "state") : undefined
    const backupDir = join(storageDir ?? getDefaultStorageDir(), "fork-recovery-backups")
    const history: any[] = [
        { id: "source-prompt", type: "user", text: "Inspect the project." },
        { id: "source-old", type: "assistant", content: [{ type: "text", text: "OLD_CONTENT" }] },
        {
            id: "source-compress",
            type: "assistant",
            content: [
                {
                    type: "tool",
                    id: "source-call",
                    name: "acp_compress",
                    state: {
                        status: "completed",
                        input: {
                            content: [
                                { startId: "m00002", endId: "m00002", summary: "Saved summary." },
                            ],
                        },
                        content: "Compressed.",
                    },
                },
            ],
        },
    ]
    const source = createSessionState()
    source.sessionId = "source"
    source.storageDir = storageDir
    assert.equal(
        rebuildCompressionState(source, fromV2SessionMessages(history, "source"), config, logger),
        1,
    )
    source.stickyTruncations = {
        "source-call": "Frozen source output",
        "outside-call": "Not copied",
    }
    await saveSessionState(source, logger)
    const forkHistory = structuredClone(history)
    for (const message of forkHistory) {
        message.id = message.id.replace("source-", "fork-")
        for (const part of message.content ?? []) {
            if (part.type === "tool") {
                part.id = "fork-call"
                delete part.state.input
            }
        }
    }
    const empty = createSessionState()
    empty.sessionId = "fork"
    empty.storageDir = storageDir
    for (const [raw, ref] of source.messageIds.byRawId) {
        const forkRaw = raw.replace("source-", "fork-")
        empty.messageIds.byRawId.set(forkRaw, ref)
        empty.messageIds.byRef.set(ref, forkRaw)
    }
    empty.messageIds.byRawId.set("older-unavailable-message", "m00050")
    empty.messageIds.byRef.set("m00050", "older-unavailable-message")
    empty.messageIds.nextRef = 100
    empty.modelContextLimit = 128000
    empty.modelProviderID = "provider"
    empty.modelID = "model"
    empty.nudges.contextLimitAnchors.add("fork-prompt")
    empty.stickyTruncations = { "local-call": "Keep local output" }
    await saveSessionState(empty, logger)
    const baselineSets = nativeSets
    const notifications: Array<{ sessionID: string; text: string; description: string }> = []
    const requests: string[] = []
    let metadata: any = {
        fork: { sessionID: "source", boundary: { type: "through", messageID: "source-compress" } },
    }
    const client = {
        session: {
            get: async () => metadata,
            context: async ({ sessionID }: { sessionID: string }) => {
                requests.push(sessionID)
                return sessionID === "source" ? history : forkHistory
            },
            synthetic: async (notification: (typeof notifications)[number]) => {
                notifications.push(notification)
            },
        },
    }
    const registry = new SessionStateRegistry(logger, sandbox)
    registry.getOrCreate = async () => assert.fail("Recovery must not initialize registry state")
    const invalidated: string[] = []
    const invalidate = registry.invalidate.bind(registry)
    registry.invalidate = (sessionId) => {
        invalidated.push(sessionId)
        invalidate(sessionId)
    }
    const ctx = { client, registry, config, logger, sessionId: "fork", workingDirectory: sandbox }
    const read = () => readRecoveryState("fork", storageDir)
    const replace = async (persisted: PersistedSessionState) => {
        if (customStorage)
            await writeFile(join(storageDir!, "fork.json"), JSON.stringify(persisted, null, 2))
        else storage.set("sessions/fork", structuredClone(persisted))
    }
    const prepare = () =>
        prepareForkRecovery(
            client,
            "fork",
            storageDir,
            fromV2SessionMessages(forkHistory, "fork"),
            logger,
        )
    const backups = async () =>
        readdir(backupDir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return []
            throw error
        })
    return {
        sandbox,
        storageDir,
        backupDir,
        source,
        empty,
        history,
        forkHistory,
        client,
        ctx,
        config,
        logger,
        registry,
        requests,
        notifications,
        invalidated,
        read,
        replace,
        prepare,
        backups,
        writes: () => nativeSets - baselineSets,
        setMetadata: (value: any) => {
            metadata = value
        },
        failSet: (value: typeof failNativeSet) => {
            failNativeSet = value
        },
    }
}

for (const customStorage of [false, true]) {
    const mode = customStorage ? "custom storage" : "native storage"
    test(`recovery preview, apply, restart and rollback preserve aliases and local metadata (${mode})`, async (t) => {
        const f = await fixture(t, customStorage)
        const before = await f.read()
        const original = JSON.parse(before)
        const sourceBefore = await readRecoveryState("source", f.storageDir)
        await handleRecoverForkCommand(f.ctx, "")
        assert.match(f.notifications.at(-1)!.text, /Preview only/)
        assert.match(f.notifications.at(-1)!.text, /Source: source/)
        assert.match(f.notifications.at(-1)!.text, /Blocks: 1 \(1 active\)/)
        assert.equal(await f.read(), before)
        assert.equal(f.writes(), 0)
        assert.equal(f.registry.size, 0)
        assert.deepEqual(f.invalidated, [])
        assert.deepEqual(await f.backups(), [])

        await handleRecoverForkCommand(f.ctx, "--apply")
        assert.match(f.notifications.at(-1)!.text, /Recovery applied/)
        const files = await f.backups()
        assert.equal(files.length, 1)
        const id = files[0].replace(/\.json$/, "")
        const path = join(f.backupDir, files[0])
        const backup = JSON.parse(await readFile(path, "utf8"))
        assert.equal(backup.sessionId, "fork")
        assert.equal(backup.storageDir, f.storageDir)
        assert.equal(backup.before, before)
        assert.ok(f.notifications.at(-1)!.text.includes(path))
        assert.ok(f.notifications.at(-1)!.text.includes(`--rollback ${id}`))
        const after = JSON.parse(await f.read())
        assert.deepEqual(after, backup.after)
        assert.deepEqual(after.messageIds, original.messageIds)
        assert.equal(after.messageIds.nextRef, 100)
        assert.deepEqual(after.nudges, original.nudges)
        assert.deepEqual(after.stats, original.stats)
        assert.equal(after.modelContextLimit, 128000)
        assert.equal(after.modelProviderID, "provider")
        assert.equal(after.modelID, "model")
        assert.deepEqual(after.prune.messages.activeBlockIds, [1])
        assert.deepEqual(after.prune.messages.blocksById["1"].effectiveMessageIds, ["fork-old"])
        assert.equal(after.prune.messages.blocksById["1"].compressCallId, "fork-call")
        assert.deepEqual(after.stickyTruncations, {
            "local-call": "Keep local output",
            "fork-call": "Frozen source output",
        })
        assert.equal(await readRecoveryState("source", f.storageDir), sourceBefore)
        assert.deepEqual(f.invalidated, ["fork"])
        assert.equal(f.writes(), customStorage ? 0 : 1)

        const restartedRegistry = new SessionStateRegistry(f.logger, f.sandbox)
        const restarted = await restartedRegistry.getOrCreate(
            f.client,
            "fork",
            fromV2SessionMessages(f.forkHistory, "fork"),
            f.config,
        )
        assert.equal(restarted.prune.messages.activeBlockIds.size, 1)
        assert.equal(restarted.messageIds.nextRef, 100)
        assert.deepEqual(
            Object.fromEntries(restarted.messageIds.byRawId),
            original.messageIds.byRawId,
        )
        assert.deepEqual(restarted.stickyTruncations, after.stickyTruncations)
        // Ordinary persistence may refresh only the timestamp before rollback.
        after.lastUpdated = "2030-01-01T00:00:00.000Z"
        await f.replace(after)
        const writesBeforeRollback = f.writes()
        await handleRecoverForkCommand(f.ctx, `--rollback ${id}`)
        assert.match(f.notifications.at(-1)!.text, /Rollback completed/)
        assert.equal(await f.read(), before)
        assert.deepEqual(f.invalidated, ["fork", "fork"])
        assert.equal(f.writes() - writesBeforeRollback, customStorage ? 0 : 1)
        const restored = await new SessionStateRegistry(f.logger, f.sandbox).getOrCreate(
            f.client,
            "fork",
            fromV2SessionMessages(f.forkHistory, "fork"),
            f.config,
        )
        assert.equal(restored.prune.messages.blocksById.size, 0)
        assert.equal(restored.messageIds.nextRef, 100)
    })

    test(`rollback refuses newer persisted work and leaves the recovery backup intact (${mode})`, async (t) => {
        const f = await fixture(t, customStorage)
        const plan = await f.prepare()
        const backup = await applyForkRecovery("fork", f.storageDir, plan, () => true)
        const changed = JSON.parse(await f.read())
        changed.messageIds.nextRef++
        await f.replace(changed)
        const beforeRollback = await f.read()
        await handleRecoverForkCommand(f.ctx, `--rollback ${backup.id}`)
        assert.match(f.notifications.at(-1)!.text, /changed since recovery; rollback refused/)
        assert.equal(await f.read(), beforeRollback)
        assert.deepEqual(f.invalidated, [])
        assert.deepEqual(await f.backups(), [`${backup.id}.json`])
    })

    test(`backup failure prevents any recovery write (${mode})`, async (t) => {
        const f = await fixture(t, customStorage)
        const plan = await f.prepare()
        await mkdir(join(f.backupDir, ".."), { recursive: true })
        await writeFile(f.backupDir, "Not a directory")
        await assert.rejects(
            applyForkRecovery("fork", f.storageDir, plan, () => true),
            /EEXIST|ENOTDIR/,
        )
        assert.equal(await f.read(), plan.before)
        assert.equal(f.writes(), 0)
    })
}

const nonEmptyCases: Array<[string, (state: PersistedSessionState) => void]> = [
    [
        "inactive block",
        (state) => {
            state.prune.messages!.blocksById["8"] = { active: false } as any
        },
    ],
    [
        "message membership",
        (state) => {
            state.prune.messages!.byMessageId["old"] = {
                tokenCount: 1,
                allBlockIds: [8],
                activeBlockIds: [],
            }
        },
    ],
    [
        "active anchor",
        (state) => {
            state.prune.messages!.activeByAnchorMessageId["old"] = 8
        },
    ],
    [
        "active block",
        (state) => {
            state.prune.messages!.activeBlockIds.push(8)
        },
    ],
    [
        "cleanup marker",
        (state) => {
            state.prune.messages!.markedForCleanup = [8]
        },
    ],
    [
        "block counter",
        (state) => {
            state.prune.messages!.nextBlockId = 9
        },
    ],
    [
        "run counter",
        (state) => {
            state.prune.messages!.nextRunId = 2
        },
    ],
    [
        "prune counter",
        (state) => {
            state.stats.pruneTokenCounter = 1
        },
    ],
    [
        "total tokens",
        (state) => {
            state.stats.totalPruneTokens = 1
        },
    ],
    [
        "legacy tool membership",
        (state) => {
            state.prune.tools = { "old-call": 1 }
        },
    ],
]
for (const [name, mutate] of nonEmptyCases) {
    test(`recovery refuses persisted ${name} before normalization`, async (t) => {
        const f = await fixture(t)
        const persisted = JSON.parse(await f.read())
        mutate(persisted)
        await f.replace(persisted)
        const before = await f.read()
        await assert.rejects(f.prepare(), /completely empty compression history/)
        assert.equal(await f.read(), before)
        assert.equal(f.writes(), 0)
        assert.deepEqual(await f.backups(), [])
    })
}

test("recovery refuses live compression history even when persisted state is empty", async (t) => {
    const f = await fixture(t)
    f.empty.prune.messages.nextRunId = 2
    await assert.rejects(
        prepareForkRecovery(
            f.client,
            "fork",
            f.storageDir,
            fromV2SessionMessages(f.forkHistory, "fork"),
            f.logger,
            f.empty,
        ),
        /completely empty compression history/,
    )
    assert.equal(f.writes(), 0)
})

for (const scenario of [
    "missing source",
    "missing boundary",
    "missing mapping",
    "invalid provenance",
] as const) {
    test(`recovery fails closed for ${scenario}`, async (t) => {
        const f = await fixture(t)
        if (scenario === "missing source")
            f.setMetadata({
                fork: {
                    sessionID: "missing",
                    boundary: { type: "through", messageID: "source-compress" },
                },
            })
        if (scenario === "missing boundary")
            f.setMetadata({
                fork: { sessionID: "source", boundary: { type: "through", messageID: "missing" } },
            })
        if (scenario === "missing mapping") f.forkHistory[1].content[0].text = "Different history"
        if (scenario === "invalid provenance") f.setMetadata({ parentID: "source" })
        const before = await f.read()
        await assert.rejects(f.prepare(), /unavailable|cannot be mapped|no valid fork/)
        assert.equal(await f.read(), before)
        assert.equal(f.writes(), 0)
        assert.deepEqual(await f.backups(), [])
    })
}

for (const input of [{ blockId: "b1" }, undefined]) {
    test(`recovery refuses ${input ? "mutating" : "ambiguous"} completed decompression`, async (t) => {
        const f = await fixture(t)
        f.forkHistory.push({
            id: "fork-decompress",
            type: "assistant",
            content: [
                {
                    type: "tool",
                    id: "decompress-call",
                    name: "acp_decompress",
                    state: { status: "completed", input, content: "Restored" },
                },
            ],
        })
        await assert.rejects(f.prepare(), /Decompression history is present or ambiguous/)
        assert.equal(f.writes(), 0)
    })
}

test("file-only decompression export does not prevent safe source recovery", async (t) => {
    const f = await fixture(t)
    f.forkHistory.push({
        id: "fork-export",
        type: "assistant",
        content: [
            {
                type: "tool",
                id: "export-call",
                name: "acp_decompress",
                state: {
                    status: "completed",
                    input: { blockId: "b1", toFile: "export.md" },
                    content: "Exported",
                },
            },
        ],
    })
    const plan = await f.prepare()
    assert.equal(plan.restored, 1)
    assert.equal(plan.after.messageIds!.byRawId["fork-export"], "m00100")
    assert.equal(plan.after.messageIds!.nextRef, 101)
    assert.equal(f.writes(), 0)
})

for (const scenario of ["live mutation", "persisted mutation"] as const) {
    test(`apply refuses ${scenario} after preview without creating a backup`, async (t) => {
        const f = await fixture(t)
        const plan = await f.prepare()
        if (scenario === "persisted mutation") {
            const changed = JSON.parse(await f.read())
            changed.messageIds.nextRef++
            await f.replace(changed)
        }
        const before = await f.read()
        await assert.rejects(
            applyForkRecovery("fork", f.storageDir, plan, () => scenario !== "live mutation"),
            /Session changed during recovery/,
        )
        assert.equal(await f.read(), before)
        assert.equal(f.writes(), 0)
        assert.deepEqual(await f.backups(), [])
    })
}

for (const failure of ["before", "after"] as const) {
    test(`native set failure ${failure} commit retains actionable backup without publishing live state`, async (t) => {
        const f = await fixture(t)
        const before = await f.read()
        f.failSet(failure)
        await handleRecoverForkCommand(f.ctx, "--apply")
        const report = f.notifications.at(-1)!.text
        assert.match(report, /Recovery could not be confirmed/)
        assert.match(report, /Native set failed/)
        const files = await f.backups()
        assert.equal(files.length, 1)
        const id = files[0].replace(/\.json$/, "")
        assert.ok(report.includes(`--rollback ${id}`))
        assert.deepEqual(f.invalidated, ["fork"])
        assert.equal(f.writes(), 1)
        if (failure === "before") assert.equal(await f.read(), before)
        else {
            assert.notEqual(await f.read(), before)
            f.failSet(undefined)
            await withSessionRecovery("fork", f.storageDir, () =>
                rollbackForkRecovery("fork", f.storageDir, id),
            )
            assert.equal(await f.read(), before)
        }
    })
}

test("maintenance guard blocks ordinary saves, nested recovery and unguarded writes", async (t) => {
    const f = await fixture(t)
    const before = await f.read()
    await assert.rejects(writeRecoveryState("fork", f.storageDir, before), /maintenance guard/)
    await withSessionRecovery("fork", f.storageDir, async () => {
        await assert.rejects(saveSessionState(f.empty, f.logger), /recovery is in progress/)
        await assert.rejects(
            withSessionRecovery("fork", f.storageDir, async () => undefined),
            /recovery is in progress/,
        )
        assert.throws(() => f.registry.get("fork"), /recovery is in progress/)
    })
    assert.equal(await f.read(), before)
    assert.equal(f.writes(), 0)
})

test("pending ordinary save prevents maintenance from overtaking queued state", async (t) => {
    const f = await fixture(t)
    const pending = saveSessionState(f.empty, f.logger)
    await assert.rejects(
        withSessionRecovery("fork", f.storageDir, async () =>
            assert.fail("Must not enter recovery"),
        ),
        /saves are pending/,
    )
    await pending
    assert.equal(f.writes(), 1)
})

test("apply refuses pending ordinary saves without writing a recovery backup", async (t) => {
    const f = await fixture(t)
    const plan = await f.prepare()
    const pending = saveSessionState(f.empty, f.logger)
    await assert.rejects(
        applyForkRecovery("fork", f.storageDir, plan, () => true),
        /saves are pending/,
    )
    await pending
    assert.equal(f.writes(), 1)
    assert.deepEqual(await f.backups(), [])
})

test("rollback validates backup identity and rejects path-shaped IDs", async (t) => {
    const f = await fixture(t)
    const plan = await f.prepare()
    const backup = await applyForkRecovery("fork", f.storageDir, plan, () => true)
    const before = await f.read()
    await assert.rejects(
        withSessionRecovery("other", f.storageDir, () =>
            rollbackForkRecovery("other", f.storageDir, backup.id),
        ),
        /different session or storage location/,
    )
    await assert.rejects(
        withSessionRecovery("fork", f.storageDir, () =>
            rollbackForkRecovery("fork", f.storageDir, "../fork"),
        ),
        /Invalid recovery backup ID/,
    )
    assert.equal(await f.read(), before)
})

test("command hook intercepts recovery before initialization and always emits the handled sentinel", async (t) => {
    const f = await fixture(t)
    const handler = createCommandExecuteHandler(
        f.client,
        f.registry,
        f.logger,
        f.config,
        f.sandbox,
        { global: undefined, agents: {} },
    )
    const output = { parts: [{ type: "text", text: "Existing part" }] }
    const original = structuredClone(output)
    const before = await f.read()
    for (const arguments_ of [
        " ReCoVeR-FoRk ",
        "recover-fork --unknown",
        "recover-fork --rollback ../fork",
    ]) {
        await assert.rejects(
            handler({ command: "acp", sessionID: "fork", arguments: arguments_ }, output),
            { message: "__ACP_CONTEXT_HANDLED__" },
        )
        assert.equal(f.notifications.at(-1)!.sessionID, "fork")
        assert.equal(f.notifications.at(-1)!.description, "ACP")
        assert.match(f.notifications.at(-1)!.text, /^\[ACP Fork Recovery\]/)
    }
    assert.match(f.notifications[0].text, /Preview only/)
    assert.match(f.notifications[1].text, /Usage:/)
    assert.match(f.notifications[2].text, /Invalid recovery backup ID/)
    assert.deepEqual(output, original)
    assert.equal(await f.read(), before)
    assert.equal(f.registry.size, 0)
    assert.equal(f.writes(), 0)
    assert.deepEqual(await f.backups(), [])
})

test("recovery command handles unavailable history and failed notification without throwing", async (t) => {
    const f = await fixture(t)
    f.client.session.context = async () => {
        throw new Error("History unavailable")
    }
    await assert.doesNotReject(handleRecoverForkCommand(f.ctx, ""))
    assert.match(f.notifications.at(-1)!.text, /Recovery refused or failed/)
    f.client.session.synthetic = async () => {
        throw new Error("Notification unavailable")
    }
    await assert.doesNotReject(handleRecoverForkCommand(f.ctx, "--invalid"))
    assert.equal(f.writes(), 0)
})

for (const scenario of [
    "missing aliases",
    "inconsistent aliases",
    "reused high-water mark",
] as const) {
    test(`recovery rejects ${scenario} without allocating replacement refs`, async (t) => {
        const f = await fixture(t)
        const persisted = JSON.parse(await f.read())
        if (scenario === "missing aliases") delete persisted.messageIds
        if (scenario === "inconsistent aliases") persisted.messageIds.byRef.m00050 = "wrong-message"
        if (scenario === "reused high-water mark") persisted.messageIds.nextRef = 50
        await f.replace(persisted)
        const before = await f.read()
        await assert.rejects(f.prepare(), /Persisted message aliases/)
        assert.equal(await f.read(), before)
        assert.equal(f.writes(), 0)
    })
}

test("recovery refuses to create a missing target state", async (t) => {
    const f = await fixture(t)
    configureNativeStateStorage({
        get: async () => undefined,
        set: async () => assert.fail("Missing state must not be created by recovery"),
    })
    await assert.rejects(f.prepare(), /No persisted session state/)
    assert.deepEqual(await f.backups(), [])
})

test("recovery rejects unsaved live metadata instead of overwriting it", async (t) => {
    const f = await fixture(t)
    f.empty.messageIds.nextRef++
    await assert.rejects(
        prepareForkRecovery(
            f.client,
            "fork",
            f.storageDir,
            fromV2SessionMessages(f.forkHistory, "fork"),
            f.logger,
            f.empty,
        ),
        /Live state differs from persisted state/,
    )
    assert.equal(f.writes(), 0)
})

test("recovery rejects incomplete inactive descendants in the source graph", async (t) => {
    const f = await fixture(t)
    f.source.prune.messages.blocksById.get(1)!.includedBlockIds.push(99)
    await saveSessionState(f.source, f.logger)
    await assert.rejects(
        f.prepare(),
        /Nested source block history is incomplete|cannot be mapped completely/,
    )
    assert.deepEqual(await f.backups(), [])
})

test("recovery never overwrites a conflicting frozen tool output", async (t) => {
    const f = await fixture(t)
    const persisted = JSON.parse(await f.read())
    persisted.stickyTruncations["fork-call"] = "Existing fork output"
    await f.replace(persisted)
    const before = await f.read()
    await assert.rejects(f.prepare(), /conflicts with an existing frozen tool output/)
    assert.equal(await f.read(), before)
    assert.equal(f.writes(), 0)
})

test("apply rechecks live state after backing up and before committing", async (t) => {
    const f = await fixture(t)
    const plan = await f.prepare()
    let checks = 0
    await assert.rejects(
        applyForkRecovery("fork", f.storageDir, plan, () => ++checks < 2),
        /Session changed during recovery/,
    )
    assert.equal(checks, 2)
    assert.equal(await f.read(), plan.before)
    assert.equal(f.writes(), 0)
    assert.equal((await f.backups()).length, 1)
})

test("native rollback commit-then-throw retires cached state while preserving the restored bytes", async (t) => {
    const f = await fixture(t)
    const registry = new SessionStateRegistry(f.logger, f.sandbox)
    await registry.getOrCreate(
        f.client,
        "fork",
        fromV2SessionMessages(f.forkHistory, "fork"),
        f.config,
    )
    f.ctx.registry = registry
    const before = await f.read()
    await handleRecoverForkCommand(f.ctx, "--apply")
    const id = (await f.backups())[0].replace(/\.json$/, "")
    const live = await registry.getOrCreate(
        f.client,
        "fork",
        fromV2SessionMessages(f.forkHistory, "fork"),
        f.config,
    )
    const expectedAfter = JSON.parse(await readFile(join(f.backupDir, `${id}.json`), "utf8")).after
    const actualAfter = JSON.parse(await f.read())
    actualAfter.lastUpdated = expectedAfter.lastUpdated
    assert.deepEqual(actualAfter, expectedAfter)
    f.failSet("after")
    const writesBeforeRollback = f.writes()
    await assert.doesNotReject(handleRecoverForkCommand(f.ctx, `--rollback ${id}`))
    assert.match(
        f.notifications.at(-1)!.text,
        /Recovery refused or failed.*Native set failed after commit/s,
    )
    assert.equal(await f.read(), before)
    assert.equal(registry.get("fork"), undefined)
    assert.equal(f.writes() - writesBeforeRollback, 1)
    f.failSet(undefined)
    await assert.rejects(saveSessionState(live, f.logger), /replaced by fork recovery/)
    assert.equal(await f.read(), before)
})

test("rollback refuses unsaved live work without invalidating or overwriting it", async (t) => {
    const f = await fixture(t)
    await handleRecoverForkCommand(f.ctx, "--apply")
    const id = (await f.backups())[0].replace(/\.json$/, "")
    const registry = new SessionStateRegistry(f.logger, f.sandbox)
    const live = await registry.getOrCreate(
        f.client,
        "fork",
        fromV2SessionMessages(f.forkHistory, "fork"),
        f.config,
    )
    f.ctx.registry = registry
    live.stickyTruncations["new-live-call"] = "Unsaved local work"
    const before = await f.read()
    const writesBeforeRollback = f.writes()
    await handleRecoverForkCommand(f.ctx, `--rollback ${id}`)
    assert.match(
        f.notifications.at(-1)!.text,
        /Live state differs from persisted state; rollback refused/,
    )
    assert.equal(registry.get("fork"), live)
    assert.equal(live.stickyTruncations["new-live-call"], "Unsaved local work")
    assert.equal(await f.read(), before)
    assert.equal(f.writes(), writesBeforeRollback)
})

test("apply retires the previous live state so a delayed save cannot overwrite recovery", async (t) => {
    const f = await fixture(t)
    const registry = new SessionStateRegistry(f.logger, f.sandbox)
    const live = await registry.getOrCreate(
        f.client,
        "fork",
        fromV2SessionMessages(f.forkHistory, "fork"),
        f.config,
    )
    f.ctx.registry = registry
    await handleRecoverForkCommand(f.ctx, "--apply")
    assert.match(f.notifications.at(-1)!.text, /Recovery applied/)
    const recovered = await f.read()
    assert.equal(registry.get("fork"), undefined)
    await assert.rejects(saveSessionState(live, f.logger), /replaced by fork recovery/)
    assert.equal(await f.read(), recovered)
})

test("snapshot used for recovery captures existing references without normalizing history", async (t) => {
    const f = await fixture(t)
    const snapshot = snapshotSessionState(f.empty)
    assert.equal(snapshot.messageIds!.nextRef, 100)
    assert.equal(snapshot.messageIds!.byRef.m00050, "older-unavailable-message")
    assert.deepEqual(snapshot.prune.messages!.blocksById, {})
    assert.equal(snapshot.prune.messages!.nextBlockId, 1)
})
