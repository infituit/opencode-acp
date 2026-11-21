import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { getConfig } from "../src/config"
import { COMPACTED_TOOL_OUTPUT_PLACEHOLDER, countTokens } from "../src/context-usage"
import { Logger } from "../src/logger"
import { enforceContextBudget, estimateWireTokens } from "../src/messages/enforce-budget"
import {
    applyStickyTruncations,
    recordStickyTruncations,
    snapshotToolOutputs,
} from "../src/messages/sticky-truncation"
import { truncateLargeToolOutputs } from "../src/messages/truncate-tools"
import { PromptStore } from "../src/prompts/store"
import { createSessionState, type SessionStateRegistry, type WithParts } from "../src/state"
import { configureNativeStateStorage } from "../src/state/persistence"
import { createChatMessageTransformHandler } from "../src/v2/hooks"
import { fromV2SessionMessages } from "../src/v2/messages"

const largeOutput = Array.from({ length: 700 }, (_, i) => `Build record ${i}: completed.\n`).join(
    "",
)
const truncatedMarker = "[truncated for context space"
const protectionCases = [
    { name: "exact tool", tool: "private_lookup", input: {}, tools: ["private_lookup"] },
    { name: "wildcard tool", tool: "mcp_private_lookup", input: {}, tools: ["mcp_private_*"] },
    { name: "V2 file path", tool: "read", input: { path: "docs/AGENTS.md" }, tools: [] },
    {
        name: "patch move destination",
        tool: "patch",
        input: {
            patchText: [
                "*** Begin Patch",
                "*** Update File: docs/ordinary.md",
                "*** Move to: docs/AGENTS.md",
                "@@",
                "-old",
                "+new",
                "*** End Patch",
            ].join("\n"),
        },
        tools: [],
    },
]

async function fixture(t: TestContext) {
    const sandbox = await mkdtemp(join(tmpdir(), "acp-emergency-protection-"))
    const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"] as const
    const previous = keys.map((key) => process.env[key])
    for (const key of keys) process.env[key] = sandbox
    const storage = new Map<string, unknown>()
    configureNativeStateStorage({
        get: async (key) => structuredClone(storage.get(key)),
        set: async (key, value) => {
            storage.set(key, structuredClone(value))
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
    config.compress.images.enabled = false
    config.compress.permission = "deny"
    config.compress.protectedTools = []
    config.protectedFilePatterns = []
    config.compress.completionReserveTokens = 0
    const state = createSessionState()
    state.sessionId = "emergency-protection"
    state.storageDir = sandbox
    return { sandbox, logger, config, state }
}

function history(protection = protectionCases[0], output: unknown = largeOutput) {
    const messages = fromV2SessionMessages(
        [
            { id: "user", type: "user", text: "Inspect build records.", createdAt: 100 },
            {
                id: "mixed",
                type: "assistant",
                createdAt: 200,
                content: [
                    {
                        type: "tool",
                        id: "protected",
                        name: protection.tool,
                        input: protection.input,
                        result: output,
                    },
                    { type: "tool", id: "sibling", name: "shell", input: {}, result: output },
                ],
            },
            {
                id: "control",
                type: "assistant",
                createdAt: 300,
                content: [
                    { type: "tool", id: "ordinary", name: "shell", input: {}, result: output },
                ],
            },
            ...["recent-a", "recent-b", "recent-c"].map((id, i) => ({
                id,
                type: "assistant",
                createdAt: 400 + i,
                content: [{ type: "text", text: id }],
            })),
        ],
        "emergency-protection",
    )
    // V2 conversion normalizes results to strings. Exercise the guards' legacy
    // object-output tolerance with actual objects, not pre-stringified fixtures.
    if (typeof output !== "string") {
        for (const message of messages) {
            for (const part of message.parts) {
                if (part.type === "tool" && part.state.status === "completed") {
                    Object.assign(part.state, { output: structuredClone(output) })
                }
            }
        }
    }
    return messages
}

function toolPart(messages: WithParts[], callID: string) {
    const part = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.callID === callID)
    assert.ok(part?.type === "tool", `Missing tool call ${callID}`)
    assert.equal(part.state.status, "completed")
    if (part.state.status !== "completed") throw new Error("Expected completed tool fixture")
    return part
}

for (const protection of protectionCases) {
    for (const guard of ["large output", "budget phase 1", "budget phase 2"] as const) {
        test(`${guard} respects ${protection.name} for the whole mixed message`, async (t) => {
            const { logger, config, state } = await fixture(t)
            config.compress.protectedTools = protection.tools
            config.protectedFilePatterns = ["**/AGENTS.md"]
            const messages = history(protection)
            const originalMixed = structuredClone(messages[1])
            if (guard === "large output") {
                state.modelContextLimit = 20000
                config.gc.majorGcThresholdPercent = 1
                truncateLargeToolOutputs(state, config, logger, messages)
                assert.ok(
                    String(toolPart(messages, "ordinary").state.output).includes(truncatedMarker),
                )
            } else {
                const estimate = estimateWireTokens(state, messages)
                state.modelContextLimit =
                    guard === "budget phase 1"
                        ? estimate - Math.floor(countTokens(largeOutput) / 2)
                        : 1
                const result = enforceContextBudget(state, config, logger, messages)
                assert.ok(
                    result?.applied,
                    "The non-protected control must trigger the budget guard",
                )
                if (guard === "budget phase 1") {
                    assert.ok(result.truncatedCount > 0)
                    assert.equal(result.clearedCount, 0)
                    assert.ok(
                        String(toolPart(messages, "ordinary").state.output).includes(
                            truncatedMarker,
                        ),
                    )
                } else {
                    assert.ok(result.clearedCount > 0)
                    assert.equal(
                        toolPart(messages, "ordinary").state.output,
                        COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
                    )
                    assert.ok(
                        result.finalEstimate > result.budget,
                        "Protected data may leave the request over budget",
                    )
                }
            }
            assert.deepEqual(
                messages[1],
                originalMixed,
                "Protection includes ordinary siblings, IDs and input",
            )
        })
    }
}

for (const protection of protectionCases) {
    for (const shape of ["string", "object"] as const) {
        test(`sticky replay respects newly configured ${protection.name} for ${shape} outputs`, async (t) => {
            const { logger, config, state } = await fixture(t)
            const fresh =
                shape === "string" ? "Fresh complete output" : { records: ["fresh", "complete"] }
            const messages = history(protection, fresh)
            assert.equal(typeof toolPart(messages, "protected").state.output, shape)
            state.stickyTruncations = {
                protected: "frozen protected output",
                sibling: "frozen sibling output",
                ordinary: "frozen ordinary output",
                vanished: "frozen vanished output",
            }
            const initial = structuredClone(state.stickyTruncations)
            const unprotected = structuredClone(messages)
            applyStickyTruncations(state, unprotected, logger, config)
            assert.equal(toolPart(unprotected, "protected").state.output, initial.protected)
            assert.equal(toolPart(unprotected, "sibling").state.output, initial.sibling)
            assert.equal(toolPart(unprotected, "ordinary").state.output, initial.ordinary)
            assert.equal("vanished" in state.stickyTruncations, false)

            // A later config load newly protects an existing frozen call. Keep the
            // entry, but do not overwrite the fresh authoritative request view.
            config.compress.protectedTools = protection.tools
            config.protectedFilePatterns = ["**/AGENTS.md"]
            const mixedBefore = structuredClone(messages[1])
            applyStickyTruncations(state, messages, logger, config)
            assert.deepEqual(messages[1], mixedBefore)
            assert.equal(toolPart(messages, "ordinary").state.output, initial.ordinary)
            assert.deepEqual(state.stickyTruncations, {
                protected: initial.protected,
                sibling: initial.sibling,
                ordinary: initial.ordinary,
            })
            const before = snapshotToolOutputs(messages)
            assert.equal(recordStickyTruncations(state, messages, before, logger), 0)
            assert.equal(state.stickyTruncations.protected, initial.protected)

            // Protection is not a restore path for already compacted durable data.
            toolPart(messages, "protected").state.output = COMPACTED_TOOL_OUTPUT_PLACEHOLDER
            applyStickyTruncations(state, messages, logger, config)
            assert.equal(
                toolPart(messages, "protected").state.output,
                COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
            )
            assert.equal(state.stickyTruncations.protected, initial.protected)
        })
    }
}

test("sticky recording still freezes only changed stringified outputs and clears", async (t) => {
    const { logger, state } = await fixture(t)
    const messages = history(protectionCases[0], { full: "original output" })
    const before = snapshotToolOutputs(messages)
    toolPart(messages, "protected").state.output = "truncated output"
    toolPart(messages, "ordinary").state.output = COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    assert.equal(recordStickyTruncations(state, messages, before, logger), 2)
    assert.deepEqual(state.stickyTruncations, {
        protected: "truncated output",
        ordinary: COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
    })
    assert.equal(recordStickyTruncations(state, messages, before, logger), 0)
})

test("message hook keeps emergency truncation opt-in and passes protection to sticky replay", async (t) => {
    const { sandbox, logger, config, state } = await fixture(t)
    assert.equal(config.compress.emergencyTruncation, false)
    config.compress.protectedTools = ["private_*"]
    config.gc.majorGcThresholdPercent = 1
    const registry = {
        async getOrCreate() {
            return state
        },
        resolveModelLimit() {
            return 20000
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
    const messages = history()
    const frozen = {
        protected: "frozen protected",
        sibling: "frozen sibling",
        ordinary: "frozen ordinary",
    }
    state.stickyTruncations = { ...frozen }
    const disabled = { messages: structuredClone(messages) }
    await handler({}, disabled)
    assert.deepEqual(disabled.messages, messages)
    assert.deepEqual(state.stickyTruncations, frozen)

    config.compress.emergencyTruncation = true
    const enabled = { messages: structuredClone(messages) }
    await handler({}, enabled)
    assert.deepEqual(enabled.messages[1], messages[1])
    assert.equal(toolPart(enabled.messages, "ordinary").state.output, frozen.ordinary)
    assert.deepEqual(state.stickyTruncations, frozen)
})

for (const layer of ["provider", "model"] as const) {
    for (const form of ["fresh", "frozen"] as const) {
        test(`message hook applies ${layer} tool protection to ${form} emergency outputs`, async (t) => {
            const { sandbox, logger, config, state } = await fixture(t)
            const override = {
                emergencyTruncation: true,
                protectedTools: layer === "provider" ? ["private_lookup"] : ["private_*"],
            }
            config.compress.providers = {
                testProvider: layer === "provider" ? override : { models: { testModel: override } },
            }
            config.gc.majorGcThresholdPercent = 1
            assert.deepEqual(config.compress.protectedTools, [])
            assert.equal(config.compress.emergencyTruncation, false)
            const originalConfig = structuredClone(config)
            let contextLimit = 20000
            let resolved = 0
            const registry = {
                async getOrCreate() {
                    resolved++
                    return state
                },
                resolveModelLimit() {
                    return contextLimit
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
            // Fresh requests exercise each guard separately: a tiny GC threshold
            // triggers large-output truncation; a sub-overhead window bypasses
            // that guard but forces enforceContextBudget to clear the control.
            const scenarios = form === "fresh" ? ["large", "budget"] : ["sticky"]
            for (const scenario of scenarios) {
                contextLimit = scenario === "budget" ? 1000 : 20000
                state.stickyTruncations =
                    form === "frozen"
                        ? {
                              protected: "frozen protected",
                              sibling: "frozen sibling",
                              ordinary: "frozen ordinary",
                          }
                        : {}
                const frozenBefore = structuredClone(state.stickyTruncations)
                const messages = history()
                Object.assign(messages[0].info, {
                    model: { providerID: "testProvider", modelID: "testModel" },
                })
                const mixedBefore = structuredClone(messages[1])
                await handler({}, { messages })
                const ordinary = toolPart(messages, "ordinary").state.output
                if (scenario === "sticky") {
                    assert.equal(
                        ordinary,
                        "frozen ordinary",
                        "The enabled override must enter sticky replay",
                    )
                    assert.deepEqual(state.stickyTruncations, frozenBefore)
                } else if (scenario === "budget") {
                    assert.equal(
                        ordinary,
                        COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
                        "The budget guard must actually run",
                    )
                } else {
                    assert.ok(
                        String(ordinary).includes(truncatedMarker),
                        "The large-output guard must actually run",
                    )
                }
                assert.deepEqual(
                    config,
                    originalConfig,
                    "Effective overrides must not mutate base config",
                )
                assert.deepEqual(
                    messages[1],
                    mixedBefore,
                    "Override protection includes ordinary sibling tools",
                )
            }
            assert.equal(
                resolved,
                scenarios.length,
                "Requests must resolve the real session, not early-return",
            )
        })
    }
}
