import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnoseContext } from "../src/diagnostics"
import { Logger } from "../src/logger"
import { createChatMessageTransformHandler } from "../src/hooks"
import { getConfig } from "../src/config"
import { PromptStore } from "../src/prompts/store"
import { createSessionState, type SessionStateRegistry } from "../src/state"
import { fromV2SessionMessages } from "../src/v2/messages"

// Synthetic pipeline comparison, not a production latency or CPU attribution benchmark.
const sandbox = await mkdtemp(join(tmpdir(), "acp-diagnostics-benchmark-"))
const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
const previous = keys.map((key) => process.env[key])
for (const key of keys) process.env[key] = sandbox
try {
    const logger = new Logger(false, "info")
    logger.info = () => undefined
    logger.warn = () => undefined
    logger.error = () => undefined
    logger.diagnostic = async () => {}
    const config = getConfig({ directory: sandbox })
    config.compress.images.enabled = false
    config.compress.maxContextLimit = Number.MAX_SAFE_INTEGER
    config.compress.minContextLimit = Number.MAX_SAFE_INTEGER
    config.compress.iterationNudgeThreshold = Number.MAX_SAFE_INTEGER
    for (const count of [2, 30]) {
        const input = fromV2SessionMessages(
            [
                { id: "user", type: "user", text: "Inspect the synthetic history." },
                ...Array.from({ length: count }, (_, i) => ({
                    id: `assistant-${i}`,
                    type: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: `call-${i}`,
                            name: "read",
                            input: {},
                            result: "Synthetic log record with identifiers and timestamp 2026-10-31.\n".repeat(
                                300,
                            ),
                        },
                    ],
                })),
            ],
            "benchmark",
        )
        const run = async (enabled: boolean) => {
            const state = createSessionState()
            state.sessionId = "benchmark"
            state.storageDir = sandbox
            const registry = {
                async getOrCreate() {
                    return state
                },
                resolveModelLimit() {
                    return 10000000
                },
            } as unknown as SessionStateRegistry
            const handler = createChatMessageTransformHandler(
                {},
                registry,
                logger,
                config,
                new PromptStore(logger, sandbox),
                { global: undefined, agents: {} },
            )
            const output = { messages: structuredClone(input) }
            const startedAt = performance.now()
            if (enabled) {
                await diagnoseContext(logger, "benchmark", async (request) => {
                    request!.timeline("context", "transformMessages")
                    await handler({}, output)
                })
            } else await handler({}, output)
            return { ms: performance.now() - startedAt, output }
        }
        await run(false)
        await run(true)
        const baseline: number[] = []
        const diagnostic: number[] = []
        for (let round = 0; round < 3; round++) {
            // Alternate order to reduce systematic warm-cache/order bias.
            const first = await run(round % 2 === 0)
            const second = await run(round % 2 !== 0)
            assert.deepEqual(first.output, second.output)
            diagnostic.push(round % 2 === 0 ? first.ms : second.ms)
            baseline.push(round % 2 === 0 ? second.ms : first.ms)
        }
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]
        console.log(
            JSON.stringify({
                messages: input.length,
                serializedChars: JSON.stringify(input).length,
                baselineMs: baseline,
                diagnosticMs: diagnostic,
                medianDeltaMs: median(diagnostic) - median(baseline),
                scope: "real transform; diagnostic sink stubbed, excludes disk I/O",
            }),
        )
    }
} finally {
    keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
    })
    await rm(sandbox, { recursive: true, force: true })
}
