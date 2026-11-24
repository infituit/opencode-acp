import { SessionState, WithParts } from "./state"
import type { AssistantMessage, UserMessage } from "./state/message-types"
import { Logger } from "./logger"
import { createHash } from "node:crypto"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"
import { currentDiagnostic } from "./diagnostics"
import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
const getAnthropicTokenizer = (_anthropicTokenizer.getTokenizer ??
    (_anthropicTokenizer as any).default?.getTokenizer) as typeof _anthropicTokenizer.getTokenizer
import { getRequestInput, isUserPrompt } from "./messages/query"

// The convenience countTokens API constructs and frees a WASM tokenizer per call.
let tokenizer: ReturnType<typeof getAnthropicTokenizer> | undefined
// Retain only fingerprints and exact counts, never historical content. This bound
// limits shared process memory; histories larger than it can still miss/evict.
const TOKEN_COUNT_CACHE_LIMIT = 65_536
const tokenCounts = new Map<string, number>()

// Both consumers run the same accounting path. Only the request-time consumer
// yields; synchronous commands and guards retain their existing contract.
function* currentTokenUsage(state: SessionState, messages: WithParts[]): Generator<number> {
    const counters = currentDiagnostic()?.tokens
    if (counters) counters.usageCalls++
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AssistantMessage
        const input = assistantInfo.tokens?.input || 0
        const output = assistantInfo.tokens?.output || 0
        const reasoning = assistantInfo.tokens?.reasoning || 0
        const cacheRead = assistantInfo.tokens?.cache?.read || 0
        const cacheWrite = assistantInfo.tokens?.cache?.write || 0

        // [FIX output=0 underestimation] Accept input-only token data (output=0
        // from aborted/hidden requests). input + cacheRead + cacheWrite still
        // represents the prompt size sent to the model. Previously required
        // output > 0, which skipped these and fell through to text-only
        // estimation → massive undercount → no nudge fired → context overflow.
        if (input <= 0 && output <= 0) {
            continue
        }

        if (
            state.lastCompaction > 0 &&
            (msg.info.time.created < state.lastCompaction ||
                (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
        ) {
            if (counters) counters.compactionReset++
            return
        }

        if (counters) counters.providerUsage++
        // [FIX Bug 17] Universal token estimation
        // opencode session.ts: adjustedInputTokens = inputTokens - cacheRead - cacheWrite
        // So: input + cacheRead + cacheWrite = prompt_tokens (total input)
        // Total context usage = prompt_tokens + output + reasoning
        yield input + cacheRead + cacheWrite + output + reasoning
        return
    }

    // [FIX Bug 5] fallback: estimate from all content (text + tool outputs)
    // when no assistant message has token data (first turn or full compaction).
    if (counters) {
        counters.fullHistoryFallback++
        counters.fallbackMessages += messages.length
    }
    for (const message of messages) {
        yield countAllMessageTokens(message)
    }
}

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    let total = 0
    for (const tokens of currentTokenUsage(state, messages)) total += tokens
    return total
}

/** Exact request-time accounting, with cooperative scheduling between messages. */
export async function getCurrentTokenUsageAsync(
    state: SessionState,
    messages: WithParts[],
): Promise<number> {
    let total = 0
    let deadline = performance.now() + 8
    for (const tokens of currentTokenUsage(state, messages)) {
        total += tokens
        if (performance.now() >= deadline) {
            await yieldToEventLoop()
            deadline = performance.now() + 8
        }
    }
    return total
}

/**
 * Estimate system prompt tokens by subtracting the first user message's tokens
 * from the first assistant message's total input prompt tokens.
 *
 * The first assistant turn's prompt = system_prompt + first_user_message (+
 * any injected suffixes). By subtracting the first user message's token count
 * (via countTokens for CJK/code accuracy), we isolate the system prompt estimate.
 *
 * Uses the real Anthropic tokenizer (countTokens) — NOT length/4 — for
 * consistency with /acp context and cacheSystemPromptTokens.
 *
 * Returns 0 if no assistant message with token data is found.
 */
export function estimateSystemPromptTokens(messages: WithParts[]): number {
    let firstInput: number | undefined
    for (const msg of messages) {
        if (msg.info.role !== "assistant") continue
        const assistantInfo = msg.info as AssistantMessage
        const t = assistantInfo.tokens
        if (!t) continue
        const input = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
        if (input > 0) {
            firstInput = input
            break
        }
    }
    if (firstInput === undefined) return 0

    let firstUserText = ""
    for (const msg of messages) {
        if (!isUserPrompt(msg)) continue
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string") {
                firstUserText += part.text
            }
        }
        if (firstUserText) break
    }
    return Math.max(0, firstInput - countTokens(firstUserText))
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getRequestInput(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = userInfo.model.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0
    const counters = currentDiagnostic()?.tokens
    const startedAt = counters ? performance.now() : 0
    if (counters) {
        counters.tokenizerCalls++
        counters.tokenizerChars += text.length
    }
    try {
        // Hash raw UTF-16 code units: UTF-8 encoding replaces lone surrogates
        // and could otherwise conflate distinct strings before normalization.
        const key = createHash("sha256").update(text, "utf16le").digest("hex")
        const cached = tokenCounts.get(key)
        if (cached !== undefined) {
            tokenCounts.delete(key)
            tokenCounts.set(key, cached)
            if (counters) counters.cacheHits++
            return cached
        }
        if (counters) counters.cacheMisses++
        tokenizer ??= getAnthropicTokenizer()
        const count = tokenizer.encode(text.normalize("NFKC"), "all").length
        if (tokenCounts.size >= TOKEN_COUNT_CACHE_LIMIT) {
            const oldest = tokenCounts.keys().next().value
            if (oldest !== undefined) tokenCounts.delete(oldest)
            if (counters) counters.cacheEvictions++
        }
        tokenCounts.set(key, count)
        return count
    } catch {
        if (counters) counters.tokenizerErrors++
        try {
            tokenizer?.free()
        } catch {
            // Disposal must not prevent the existing approximate fallback.
        }
        tokenizer = undefined
        return Math.round(text.length / 4)
    } finally {
        if (counters) counters.tokenizerMs += performance.now() - startedAt
    }
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: any): string | undefined {
    if (
        part?.type !== "tool" ||
        part.state?.status !== "completed" ||
        part.state?.output === undefined
    ) {
        return undefined
    }

    if (part.state?.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part?.type !== "tool") {
        return contents
    }

    if (part.state?.input !== undefined) {
        contents.push(stringifyToolContent(part.state.input))
    }

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state?.status === "error" && part.state?.error) {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export function countToolTokens(part: any): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    let reasoningTokens = 0
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else if (part.type === "reasoning" && typeof part.text === "string") {
            reasoningTokens += countTokens(part.text)
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    return estimateTokensBatch(texts) + reasoningTokens
}

export function countMessageCharacters(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    let total = 0
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
            total += part.text.length
        } else {
            for (const content of extractToolContent(part)) {
                total += content.length
            }
        }
    }
    return total
}

/**
 * [Issue #384] Fast per-message token estimate using the chars/4 convention
 * already used across the codebase for token statistics (tool-cache.ts,
 * pipeline.ts, inject/utils.ts). The BPE-exact countAllMessageTokens costs
 * ~25ms/message on this runtime and dominated candidate planning on wide
 * draft ranges; these counters feed heuristic stats/gates, not billing.
 */
export function estimateAllMessageTokensFast(msg: WithParts): number {
    return Math.round(countMessageCharacters(msg) / 4)
}
