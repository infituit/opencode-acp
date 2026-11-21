import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { test } from "node:test"
import { resolveCompressionTarget } from "../src/commands/compression-targets"
import { createDecompressTool } from "../src/compress/decompress"
import { projectDecompression } from "../src/compress/decompress-budget"
import { checkDecompressSourceAvailability } from "../src/compress/decompress-logic"
import type { ToolFactoryContext } from "../src/compress/types"
import { getConfig } from "../src/config"
import { countAllMessageTokens, countTokens } from "../src/context-usage"
import { Logger } from "../src/logger"
import { assignMessageRefs } from "../src/message-ids"
import { syncCompressionBlocks } from "../src/messages/sync"
import { PromptStore } from "../src/prompts/store"
import { createSessionState, type CompressionBlock, type SessionStateRegistry } from "../src/state"
import { configureNativeStateStorage } from "../src/state/persistence"
import { fromV2SessionMessages } from "../src/v2/messages"

// Keep native storage and config environment isolated, as in v2-handoff-lifecycle.test.ts.
test("decompression projects the visible request before committing a budgeted restore", async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-decompress-budget-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    const storage = new Map<string, unknown>()
    let saves = 0
    configureNativeStateStorage({
        get: async (key) => structuredClone(storage.get(key)),
        set: async (key, value) => {
            saves++
            storage.set(key, structuredClone(value))
        },
    })

    function fixture(
        options: { nested?: boolean; messageMode?: boolean; shortRaw?: boolean } = {},
    ) {
        const logger = new Logger(false, "silent")
        const config = getConfig({ directory: sandbox })
        config.compress.images.enabled = false
        config.compress.completionReserveTokens = 0
        config.compress.contextLimitFallback = 0
        const state = createSessionState()
        state.sessionId = "budget-session"
        state.modelContextLimit = 100000
        state.systemPromptTokens = 37
        state.stats.totalPruneTokens = 8000
        state.stats.pruneTokenCounter = 17
        const history: Array<Record<string, any>> = [
            { id: "prompt", type: "user", text: "Keep the original task.", time: { created: 1 } },
        ]
        const blocks: CompressionBlock[] = []
        const sourceText = options.shortRaw ? "x" : "ORIGINAL_DETAIL keyword ".repeat(600)
        const addBlock = (id: number, rawId: string, summary: string) => {
            const block: CompressionBlock = {
                blockId: id,
                runId: options.messageMode ? 1 : id,
                active: true,
                deactivatedByUser: false,
                compressedTokens: countTokens(sourceText),
                summaryTokens: countTokens(summary),
                durationMs: 1,
                mode: options.messageMode ? "message" : "range",
                tier: 1,
                topic: `Topic ${id}`,
                startId: `m${String(id * 2).padStart(5, "0")}`,
                endId: `m${String(id * 2).padStart(5, "0")}`,
                anchorMessageId: rawId,
                compressMessageId: `compress-${id}`,
                compressCallId: `call-${id}`,
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [rawId],
                directToolIds: [],
                effectiveMessageIds: [rawId],
                effectiveToolIds: [],
                createdAt: id,
                summary,
                survivedCount: 0,
            }
            blocks.push(block)
            return block
        }
        const addCall = (block: CompressionBlock) => {
            history.push({
                id: block.compressMessageId,
                type: "assistant",
                time: { created: history.length + 1 },
                content: [
                    {
                        type: "tool",
                        id: block.compressCallId,
                        name: "acp_compress",
                        state: {
                            status: "completed",
                            input: {
                                content: [
                                    {
                                        startId: block.startId,
                                        endId: block.endId,
                                        summary: block.summary,
                                    },
                                ],
                            },
                            content: "Compressed.",
                        },
                    },
                ],
            })
        }
        history.push({
            id: "raw-1",
            type: "assistant",
            time: { created: 2 },
            content: [{ type: "text", text: sourceText }],
        })
        const first = addBlock(
            1,
            "raw-1",
            options.nested ? "CHILD_SUMMARY ".repeat(100) : "Short summary.",
        )
        addCall(first)
        if (options.nested) {
            const parent = addBlock(2, "raw-1", "Parent summary.")
            parent.tier = 2
            parent.directMessageIds = []
            parent.consumedBlockIds = [1]
            parent.includedBlockIds = [1]
            first.parentBlockIds = [2]
            addCall(parent)
        } else {
            history.push({
                id: "raw-2",
                type: "assistant",
                time: { created: 4 },
                content: [{ type: "text", text: sourceText }],
            })
            addCall(addBlock(2, "raw-2", "Another short summary."))
        }
        history.push({ id: "current", type: "assistant", content: [], time: { created: 7 } })
        const raw = () => fromV2SessionMessages(history, state.sessionId!)
        for (const block of blocks) state.prune.messages.blocksById.set(block.blockId, block)
        for (const id of ["raw-1", ...(options.nested ? [] : ["raw-2"])]) {
            state.prune.messages.byMessageId.set(id, {
                tokenCount: countTokens(sourceText),
                allBlockIds: blocks
                    .filter((block) => block.effectiveMessageIds.includes(id))
                    .map((block) => block.blockId),
                activeBlockIds: [],
            })
        }
        state.prune.messages.nextBlockId = 3
        state.prune.messages.nextRunId = 3
        syncCompressionBlocks(state, logger, raw())
        assignMessageRefs(state, raw())
        const tool = createDecompressTool({
            client: { session: { context: async () => history } },
            registry: { get: () => state } as unknown as SessionStateRegistry,
            state,
            logger,
            config,
            prompts: new PromptStore(logger, sandbox),
            assertPermission: async () => {},
        } as ToolFactoryContext)
        const target = (id: number) => {
            const result = resolveCompressionTarget(state.prune.messages, id)
            assert.ok(result)
            return result
        }
        const project = (ids = [options.nested ? 2 : 1], full = false) =>
            projectDecompression(state, config, logger, raw(), ids.map(target), { full })
        const execute = async (args: Record<string, unknown>) => {
            const result = await tool.execute(
                args as never,
                {
                    sessionID: state.sessionId!,
                    messageID: "current",
                    id: "decompress-call",
                } as never,
            )
            assert.equal(typeof result.content, "string")
            return result.content as string
        }
        return { state, config, logger, history, raw, target, project, execute }
    }

    function retryArgs(content: string): Record<string, unknown> {
        assert.match(content, /^Direct context restoration deferred for b\d+/)
        assert.match(content, /exceeding the \d+-token input budget/)
        assert.match(content, /No file was written\./)
        assert.match(content, /Then search.*keywords.*offset and limit/)
        assert.match(content, /Do not read the whole file back into context\./)
        const nextStep = content.match(/Next step: call acp_decompress[^\n]*:\n([^\n]+)/)
        assert.ok(
            nextStep,
            "budget guidance must contain single-line executable acp_decompress JSON",
        )
        const args = JSON.parse(nextStep[1]!) as Record<string, unknown>
        assert.equal(typeof args.toFile, "string")
        const rel = relative(tmpdir(), args.toFile as string)
        assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel))
        // Suggested names are shared across sessions; never execute them outside this sandbox.
        args.toFile = join(sandbox, "exported-content.txt")
        return args
    }

    try {
        await t.test(
            "one-tier and full restore have different projections without changing live state or raw messages",
            () => {
                const f = fixture({ nested: true })
                const raw = f.raw()
                const beforeState = structuredClone(f.state)
                const beforeRaw = structuredClone(raw)
                const target = f.target(2)
                const shallow = projectDecompression(f.state, f.config, f.logger, raw, [target], {})
                const full = projectDecompression(f.state, f.config, f.logger, raw, [target], {
                    full: true,
                })
                const tokens = (id: string) =>
                    countAllMessageTokens(raw.find((message) => message.info.id === id)!)
                const base = tokens("prompt") + f.state.systemPromptTokens!
                assert.equal(shallow.beforeTokens, base + tokens("compress-2"))
                assert.equal(shallow.afterTokens, base + tokens("compress-1"))
                assert.equal(full.afterTokens, base + tokens("raw-1"))
                assert.ok(shallow.afterTokens > shallow.beforeTokens)
                assert.ok(full.afterTokens > shallow.afterTokens)
                assert.deepEqual(f.state, beforeState)
                assert.deepEqual(raw, beforeRaw)
                assert.deepEqual(
                    checkDecompressSourceAvailability(
                        f.state.prune.messages,
                        [target],
                        {},
                        new Set(raw.map((message) => message.info.id)),
                    ).requiredMessageIds,
                    [],
                )
            },
        )

        await t.test(
            "summary-only growth is refused even when no raw message would be restored",
            async () => {
                const f = fixture({ nested: true })
                const projection = f.project()
                f.state.modelContextLimit = projection.afterTokens - 1
                const snapshot = structuredClone(f.state)
                const beforeSaves = saves
                const beforeStorage = structuredClone(storage)
                const beforeHistory = structuredClone(f.history)
                const response = await f.execute({ blockId: "b2" })
                const args = retryArgs(response)
                assert.equal(args.blockId, "b2")
                assert.deepEqual(f.state, snapshot)
                assert.deepEqual(f.history, beforeHistory)
                assert.deepEqual(storage, beforeStorage)
                assert.equal(saves, beforeSaves)
                await assert.rejects(access(args.toFile as string), { code: "ENOENT" })
            },
        )

        await t.test(
            "full restore is rejected where a one-tier restore fits; success reports estimated usage",
            async () => {
                const f = fixture({ nested: true })
                f.state.modelContextLimit = f.project().afterTokens + 1
                const response = await f.execute({ blockId: "b2", full: true })
                assert.equal(retryArgs(response).full, true)
                assert.equal(f.state.prune.messages.blocksById.get(2)?.active, true)
                const success = await f.execute({ blockId: "b2" })
                assert.match(success, /Decompressed/)
                assert.match(
                    success,
                    /Context usage:.*\(estimated text; excludes native media costs\)/,
                )
                assert.equal(f.state.prune.messages.blocksById.get(1)?.active, true)
                assert.equal(f.state.prune.messages.blocksById.get(2)?.active, false)
            },
        )

        await t.test(
            "range projection budgets all overlapping blocks together and its export retry preserves arguments",
            async () => {
                const f = fixture()
                const first = f.project([1])
                const second = f.project([2])
                const combined = f.project([1, 2])
                const budget = Math.max(first.afterTokens, second.afterTokens) + 1
                assert.ok(combined.afterTokens > budget)
                f.state.modelContextLimit = budget
                const startId = f.state.messageIds.byRawId.get("raw-1")!
                const endId = f.state.messageIds.byRawId.get("raw-2")!
                const beforeState = structuredClone(f.state)
                const beforeHistory = structuredClone(f.history)
                const beforeSaves = saves
                const response = await f.execute({ blockId: " ", startId, endId, full: true })
                const args = retryArgs(response)
                assert.equal(args.startId, startId)
                assert.equal(args.endId, endId)
                assert.equal(args.full, true)
                assert.equal(args.blockId, undefined)
                assert.deepEqual(f.state, beforeState)
                assert.deepEqual(f.history, beforeHistory)
                assert.equal(saves, beforeSaves)
                const file = args.toFile as string
                try {
                    await assert.rejects(access(file), { code: "ENOENT" })
                    const exported = await f.execute(args)
                    assert.match(exported, /stay compressed/)
                    assert.match(exported, /search.*keywords.*read.*offset.*limit/i)
                    const text = await readFile(file, "utf8")
                    assert.equal(text.split("ORIGINAL_DETAIL").length - 1, 1200)
                    assert.deepEqual(f.state, beforeState)
                    assert.deepEqual(f.history, beforeHistory)
                    assert.equal(saves, beforeSaves)
                } finally {
                    await rm(file, { force: true })
                }
            },
        )

        await t.test(
            "message-mode blocks in the same run are projected and rejected as a group",
            async () => {
                const f = fixture({ messageMode: true })
                assert.equal(f.target(1).blocks.length, 2)
                const grouped = f.project([1])
                f.state.modelContextLimit = grouped.afterTokens - 1
                const before = structuredClone(f.state)
                retryArgs(await f.execute({ blockId: "b1" }))
                assert.deepEqual(f.state, before)
            },
        )

        await t.test(
            "non-growing and shrinking decompressions are allowed even above the input budget",
            async () => {
                for (const shrinking of [false, true]) {
                    const f = fixture({ shortRaw: true })
                    if (!shrinking) {
                        f.state.prune.messages.blocksById.get(1)!.deactivatedByUser = true
                        f.state.prune.messages.structureVersion =
                            (f.state.prune.messages.structureVersion ?? 0) + 1
                        syncCompressionBlocks(f.state, f.logger, f.raw())
                    }
                    f.state.modelContextLimit = 1
                    const projection = f.project()
                    if (shrinking) assert.ok(projection.afterTokens < projection.beforeTokens)
                    else assert.equal(projection.afterTokens, projection.beforeTokens)
                    assert.ok(projection.afterTokens > projection.inputBudget!)
                    assert.match(await f.execute({ blockId: "b1" }), /Decompressed/)
                    assert.equal(f.state.prune.messages.blocksById.get(1)?.active, false)
                }
            },
        )

        await t.test(
            "missing source keeps its existing fail-closed response before the budget check",
            async () => {
                const f = fixture()
                f.state.modelContextLimit = 1
                f.history.splice(
                    f.history.findIndex((message) => message.id === "raw-1"),
                    1,
                )
                const before = structuredClone(f.state)
                const beforeSaves = saves
                const response = await f.execute({ blockId: "b1" })
                assert.match(response, /missing-source condition/)
                assert.doesNotMatch(response, /"toFile"/)
                assert.deepEqual(f.state, before)
                assert.equal(saves, beforeSaves)
            },
        )

        await t.test(
            "model window wins over fallback; absent windows allow growth; reserves are validated and clamped",
            async () => {
                const f = fixture()
                f.config.compress.contextLimitFallback = 90000
                f.config.compress.completionReserveTokens = 100
                assert.deepEqual(f.project().contextLimit, { limit: 100000, source: "model" })
                assert.equal(f.project().inputBudget, 99900)
                f.state.modelContextLimit = undefined
                assert.deepEqual(f.project().contextLimit, { limit: 90000, source: "fallback" })
                assert.equal(f.project().inputBudget, 89900)
                f.config.compress.contextLimitFallback = 0
                assert.equal(f.project().contextLimit, undefined)
                assert.equal(f.project().inputBudget, undefined)
                assert.match(await f.execute({ blockId: "b1" }), /Decompressed/)
                f.state.modelContextLimit = 1000
                for (const reserve of [undefined, -1, NaN, Infinity]) {
                    f.config.compress.completionReserveTokens = reserve
                    assert.equal(f.project([2]).completionReserve, 32768)
                    assert.equal(f.project([2]).inputBudget, 0)
                }
                f.config.compress.completionReserveTokens = 0
                assert.equal(f.project([2]).inputBudget, 1000)
                f.config.compress.completionReserveTokens = 1001
                const before = structuredClone(f.state)
                retryArgs(await f.execute({ blockId: "b2" }))
                assert.deepEqual(f.state, before)
            },
        )

        await t.test(
            "current model overrides win over historical model identity and global/provider reserves",
            () => {
                const f = fixture()
                f.history[0]!.model = { providerID: "historical", id: "old" }
                f.state.modelProviderID = "current"
                f.state.modelID = "new"
                f.config.compress.completionReserveTokens = 100
                f.config.compress.providers = {
                    historical: { completionReserveTokens: 999 },
                    current: {
                        completionReserveTokens: 200,
                        models: { new: { completionReserveTokens: 300 } },
                    },
                }
                assert.equal(f.project().completionReserve, 300)
                f.state.modelID = "other"
                assert.equal(f.project().completionReserve, 200)
                f.state.modelProviderID = undefined
                f.state.modelID = undefined
                assert.equal(f.project().completionReserve, 999)
            },
        )

        await t.test(
            "projection counts reasoning and system text rather than stale provider token accounting",
            () => {
                const f = fixture()
                f.history[1]!.content = [
                    { type: "text", text: "Short answer." },
                    { type: "reasoning", text: "PRIVATE_REASONING ".repeat(700) },
                ]
                const messages = f.raw()
                const original = messages.find((message) => message.info.id === "raw-1")!
                const target = f.target(1)
                const baseline = projectDecompression(
                    f.state,
                    f.config,
                    f.logger,
                    messages,
                    [target],
                    {},
                )
                const reasoning = original.parts.find((part) => part.type === "reasoning")!
                assert.ok(
                    baseline.afterTokens >=
                        countTokens(reasoning.text) + f.state.systemPromptTokens!,
                )
                for (const message of messages) {
                    if (message.info.role === "assistant") {
                        message.info.tokens.input = 99999999
                        message.info.tokens.output = 99999999
                        message.info.tokens.reasoning = 99999999
                    }
                }
                assert.deepEqual(
                    projectDecompression(f.state, f.config, f.logger, messages, [target], {}),
                    baseline,
                )
                original.parts = original.parts.filter((part) => part.type !== "reasoning")
                const without = projectDecompression(
                    f.state,
                    f.config,
                    f.logger,
                    messages,
                    [target],
                    {},
                )
                assert.equal(
                    baseline.afterTokens - without.afterTokens,
                    countTokens(reasoning.text),
                )
                f.state.systemPromptTokens = 0
                const noSystem = projectDecompression(
                    f.state,
                    f.config,
                    f.logger,
                    messages,
                    [target],
                    {},
                )
                assert.equal(without.beforeTokens - noSystem.beforeTokens, 37)
                assert.equal(without.afterTokens - noSystem.afterTokens, 37)
                assert.ok(countAllMessageTokens(original) < baseline.afterTokens)
            },
        )

        await t.test(
            "export bypasses the budget but retains the existing path restriction",
            async () => {
                const f = fixture()
                f.state.modelContextLimit = 1
                const before = structuredClone(f.state)
                const beforeSaves = saves
                const path = join(process.cwd(), "must-not-export-decompress-budget.txt")
                const response = await f.execute({ blockId: "b1", toFile: path })
                assert.match(response, /Error: toFile path must be under/)
                await assert.rejects(access(path), { code: "ENOENT" })
                assert.deepEqual(f.state, before)
                assert.equal(saves, beforeSaves)
            },
        )
    } finally {
        configureNativeStateStorage(undefined)
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key]
            else process.env[key] = previous[index]
        })
        await rm(sandbox, { recursive: true, force: true })
    }
})
