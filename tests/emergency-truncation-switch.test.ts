/**
 * [Issue #485] Tests for the `compress.emergencyTruncation` switch.
 *
 * The emergency truncation guards (`truncateLargeToolOutputs` +
 * `enforceContextBudget`) mutate tool outputs per-request from pristine
 * session-store content. A session hovering at the guard threshold
 * oscillates between truncated and full outputs — every flip invalidates
 * the provider prefix cache. The switch defaults to OFF; these tests pin:
 *
 *   1. Config layer: key is known, accepts booleans, rejects non-booleans.
 *   2. Pipeline (default off): an oversized old tool output that WOULD be
 *      truncated is left byte-identical by the transform.
 *   3. Pipeline (opt-in on): the same scenario truncates (marker present).
 *
 * Scenario tuning (window 40_000):
 *   - budget guard budget = 40_000 - 32_768 = 7_232; last assistant usage
 *     7_950 + ~30 new tokens ≈ 7_980 > budget → fires, phase 1 only
 *     (truncation saves ~1_460 tokens → final ≈ 6_520 ≤ budget, phase 2 skip).
 *   - GC threshold = min(100% × 40_000, 40_000 - 16_384) = 23_616 > 7_980
 *     → truncateLargeToolOutputs stays idle; only the budget guard runs.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config-validation"
import { createTestRegistry } from "./registry-stub"

const SID = "session-trunc-switch"
const TRUNCATION_MARKER = "[truncated for context space"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            emergencyTruncation: undefined,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            reasoning: { drop: true, threshold: 2048 },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
    return { ...base, ...overrides }
}

function makeUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id }],
    }
}

function makeAssistantMessage(
    id: string,
    text: string,
    extraParts: any[] = [],
    tokens?: { input: number; output: number },
): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: tokens ?? { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID: SID, messageID: id },
            { type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id },
            ...extraParts,
        ],
    }
}

function makeToolPart(callID: string, tool: string, output: string): any {
    return {
        type: "tool",
        tool,
        callID,
        id: `part-${callID}`,
        sessionID: SID,
        messageID: "msg-tool-host",
        state: { status: "completed", output, input: {}, error: undefined },
    }
}

function createMockClient() {
    return { session: { get: async () => ({ data: { parentID: null } }) } }
}

function createMockPrompts() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "ACP system",
                compressRange: "compress range",
                compressMessage: "compress message",
                contextLimitNudge: "nudge",
                turnNudge: "turn nudge",
                iterationNudge: "iteration nudge",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    }
}

function setupPipeline(config: PluginConfig) {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-trunc-switch-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = SID
    state.modelContextLimit = 40_000

    const logger = new Logger(false)
    const registry = createTestRegistry(state)
    // The transform handler reconciles state.modelContextLimit from the model
    // named on the user message (#312): an unresolved model would INVALIDATE
    // the seeded 40_000 window and disable the budget guard. Record it so the
    // catalog resolves test-provider/test-model like a real provider catalog.
    registry.recordModelLimit("test-provider", "test-model", 40_000)
    const handler = createChatMessageTransformHandler(
        createMockClient(),
        registry,
        logger,
        config,
        createMockPrompts(),
        { global: undefined, agents: {} },
    )
    return { state, handler, tempDir }
}

// 5 messages: the tool output sits at index 1, outside the last-3 protection
// window, and the last token-bearing assistant (a3) drives the usage estimate.
const BIG_TOOL_OUTPUT = "line of file content\n".repeat(450) // 9_450 chars ≈ 2_400+ tokens

function buildScenarioMessages(): WithParts[] {
    return [
        makeUserMessage("u1", "Hello"),
        makeAssistantMessage("a1", "Reading files", [
            makeToolPart("call-big-read", "read", BIG_TOOL_OUTPUT),
        ]),
        makeAssistantMessage("a2", "Done reading"),
        makeAssistantMessage("a3", "Summary so far", [], { input: 7900, output: 50 }),
        makeUserMessage("u2", "Continue the analysis"),
    ]
}

// ─── Config layer ───────────────────────────────────────────────────────────

test("config validation: compress.emergencyTruncation is a known key", () => {
    assert.deepEqual(
        getInvalidConfigKeys({ compress: { emergencyTruncation: true } }),
        [],
    )
})

test("config validation: compress.emergencyTruncation accepts booleans", () => {
    assert.deepEqual(validateConfigTypes({ compress: { emergencyTruncation: true } }), [])
    assert.deepEqual(validateConfigTypes({ compress: { emergencyTruncation: false } }), [])
})

test("config validation: compress.emergencyTruncation rejects non-booleans", () => {
    const errors = validateConfigTypes({ compress: { emergencyTruncation: "yes" } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].key, "compress.emergencyTruncation")
    assert.equal(errors[0].expected, "boolean")
})

// ─── Pipeline behavior ──────────────────────────────────────────────────────

test("default off: oversized old tool output survives the transform byte-identical", async () => {
    const { handler, tempDir } = setupPipeline(buildConfig())
    try {
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)

        const toolPart = (output.messages[1] as WithParts).parts.find(
            (p: any) => p.type === "tool",
        ) as any
        assert.ok(toolPart, "tool part must survive the pipeline")
        // Full content intact; the only allowed addition is the <dcp-message-id>
        // tag that injectMessageIds appends after the truncation stage.
        assert.ok(
            toolPart.state.output.startsWith(BIG_TOOL_OUTPUT),
            "tool output must survive byte-identical (default off)",
        )
        assert.ok(!toolPart.state.output.includes(TRUNCATION_MARKER))
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

test("opt-in on: the same scenario truncates the oversized tool output", async () => {
    const config = buildConfig()
    config.compress.emergencyTruncation = true
    const { handler, tempDir } = setupPipeline(config)
    try {
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)

        const toolPart = (output.messages[1] as WithParts).parts.find(
            (p: any) => p.type === "tool",
        ) as any
        assert.ok(toolPart, "tool part must survive the pipeline")
        assert.ok(
            toolPart.state.output.includes(TRUNCATION_MARKER),
            `expected truncation marker in output, got: ${toolPart.state.output.slice(0, 120)}…`,
        )
        assert.ok(toolPart.state.output.length < BIG_TOOL_OUTPUT.length)
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})
