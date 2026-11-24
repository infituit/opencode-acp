import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"

// Run each source in a fresh process. Compare hashes as well as elapsed times;
// this is a synthetic replay, not live provider latency or a cold-start guarantee.
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source")) {
    throw new Error("Usage: node --import tsx scripts/benchmark-long-history.ts [--source <repo>]")
}
const source = resolve(args[1] ?? ".")
const load = (path: string) => import(pathToFileURL(join(source, path)).href)
const { countTokens } = await load("src/context-usage.ts")
const { diagnoseContext } = await load("src/diagnostics.ts")
const { Logger } = await load("src/logger.ts")
const { createChatMessageTransformHandler } = await load("src/v2/hooks.ts")
const { createSessionState } = await load("src/state/index.ts")
const { fromV2SessionMessages } = await load("src/v2/messages.ts")
const { getConfig } = await load("src/config.ts")
const { PromptStore } = await load("src/prompts/store.ts")
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const round = (value: number) => Number(value.toFixed(3))
const texts = Array.from({ length: 3 }, (_, session) =>
    Array.from(
        { length: 400 },
        (_, message) =>
            `session=${session} message=${message}\n` +
            Array.from(
                { length: 16 },
                (_, line) =>
                    `record ${session}-${message}-${line}: const result = await service.read({ path: "src/module-${message % 37}.ts", retry: ${line % 3} }); 中文输出保持一致\n`,
            ).join(""),
    ),
).flat()
const count = () => {
    const started = performance.now()
    const values = texts.map((text) => countTokens(text))
    return { ms: round(performance.now() - started), hash: hash(values) }
}
const cold = count()
const warm = Array.from({ length: 3 }, count)
for (const result of warm) assert.equal(result.hash, cold.hash)
console.log(
    JSON.stringify({
        operation: "exact-count",
        source,
        messages: texts.length,
        characters: texts.reduce((sum, text) => sum + text.length, 0),
        cold,
        warm,
    }),
)

const sandbox = await mkdtemp(join(tmpdir(), "acp-long-history-benchmark-"))
const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
const previous = keys.map((key) => process.env[key])
for (const key of keys) process.env[key] = sandbox
const now = Date.now
Date.now = () => 1_800_000_000_000
try {
    const logger = new Logger(false, "info")
    logger.info = logger.warn = logger.error = () => undefined
    let record: any
    logger.diagnostic = async (_kind: string, value: unknown) => {
        record = value
    }
    const config = getConfig({ directory: sandbox })
    config.compress.images.enabled = false
    config.compress.maxContextLimit = Number.MAX_SAFE_INTEGER
    config.compress.minContextLimit = Number.MAX_SAFE_INTEGER
    config.compress.iterationNudgeThreshold = Number.MAX_SAFE_INTEGER
    const sessions = Array.from({ length: 3 }, (_, session) => {
        const id = `benchmark-${session}`
        const messages = fromV2SessionMessages(
            [
                {
                    id: `${id}-user`,
                    type: "user",
                    text: "Inspect the synthetic history.",
                    time: { created: 1 },
                },
                ...Array.from({ length: 100 }, (_, message) => ({
                    id: `${id}-message-${message}`,
                    type: "assistant",
                    time: { created: 2 + message },
                    content: [
                        {
                            type: "tool",
                            id: `${id}-tool-${message}`,
                            name: "read",
                            input: { path: `src/${message}.ts` },
                            result: `transform-${id}\n${texts[session * 400 + message]}`.repeat(5),
                        },
                    ],
                })),
            ],
            id,
        )
        return { id, messages }
    })
    const run = async () => {
        const started = performance.now()
        let lastTurn = started
        let maxTurnDelayMs = 0
        let eventLoopTurns = 0
        const heartbeat = () => {
            const now = performance.now()
            maxTurnDelayMs = Math.max(maxTurnDelayMs, now - lastTurn)
            lastTurn = now
            eventLoopTurns++
            pendingHeartbeat = setImmediate(heartbeat)
        }
        let pendingHeartbeat = setImmediate(heartbeat)
        const results = []
        const counters = []
        try {
            for (const session of sessions) {
                const state = createSessionState()
                state.sessionId = session.id
                state.storageDir = sandbox
                const registry = {
                    getOrCreate: async () => state,
                    resolveModelLimit: () => 10_000_000,
                }
                const handler = createChatMessageTransformHandler(
                    {},
                    registry,
                    logger,
                    config,
                    new PromptStore(logger, sandbox),
                    { global: undefined, agents: {} },
                )
                const output = { messages: structuredClone(session.messages) }
                await diagnoseContext(logger, session.id, async (diagnostic: any) => {
                    diagnostic.timeline("context", "transformMessages")
                    await handler({}, output)
                })
                results.push({
                    output,
                    refs: [...state.messageIds.byRawId],
                    prune: [...state.prune.messages.byMessageId],
                })
                counters.push(record?.tokens ?? null)
            }
            const finished = performance.now()
            maxTurnDelayMs = Math.max(maxTurnDelayMs, finished - lastTurn)
            return {
                ms: round(finished - started),
                maxTurnDelayMs: round(maxTurnDelayMs),
                eventLoopTurns,
                hash: hash(results),
                counters,
            }
        } finally {
            clearImmediate(pendingHeartbeat)
        }
    }
    const transformCold = await run()
    const transformWarm = []
    for (let i = 0; i < 3; i++) {
        const result = await run()
        assert.equal(result.hash, transformCold.hash)
        transformWarm.push(result)
    }
    console.log(
        JSON.stringify({
            operation: "transform",
            source,
            sessions: sessions.length,
            messages: sessions.reduce((sum, session) => sum + session.messages.length, 0),
            cold: transformCold,
            warm: transformWarm,
            scope: "synthetic transform; fixed wall clock, stubbed diagnostic sink; excludes provider/network/disk logging",
        }),
    )
} finally {
    Date.now = now
    keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
    })
    await rm(sandbox, { recursive: true, force: true })
}
