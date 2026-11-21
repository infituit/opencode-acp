import type { CompressionTarget } from "../commands/compression-targets"
import type { PluginConfig } from "../config"
import { countAllMessageTokens, countTokens } from "../context-usage"
import type { Logger } from "../logger"
import { DEFAULT_COMPLETION_RESERVE_TOKENS } from "../messages/enforce-budget"
import { applyCompressOverrides, getModelInfo } from "../messages/inject/utils"
import { prune } from "../messages/prune"
import { syncCompressionBlocks } from "../messages/sync"
import type { SessionState, WithParts } from "../state"
import { resolveEffectiveContextLimit } from "../state/utils"
import { deactivateCompressionTarget } from "./decompress-logic"
import { hideConsumedCompressCalls } from "./hide-consumed"

export interface DecompressProjection {
    beforeTokens: number
    afterTokens: number
    contextLimit: ReturnType<typeof resolveEffectiveContextLimit>
    completionReserve: number
    inputBudget: number | undefined
}

function countVisibleTokens(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    rawMessages: WithParts[],
): number {
    // Pruning replaces parts arrays; isolate the view without copying media payloads.
    const visible = rawMessages.map((message) => ({ ...message }))
    prune(state, logger, config, visible)
    hideConsumedCompressCalls(state, visible)

    let total = state.systemPromptTokens ?? 0
    for (const message of visible) {
        total += countAllMessageTokens(message)
        // The shared content counter excludes reasoning, but restored reasoning
        // also occupies the request. Native media costs remain outside this estimate.
        for (const part of message.parts) {
            if (part.type === "reasoning" && typeof part.text === "string") {
                total += countTokens(part.text)
            }
        }
    }
    return total
}

/** Project actual visibility transitions without changing live compression state or history. */
export function projectDecompression(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    rawMessages: WithParts[],
    targets: CompressionTarget[],
    options: { full?: boolean },
): DecompressProjection {
    // Prefer the active request's model over the model recorded in older history.
    const model = state.modelProviderID
        ? { providerId: state.modelProviderID, modelId: state.modelID }
        : getModelInfo(rawMessages)
    const effectiveConfig = applyCompressOverrides(config, model.providerId, model.modelId)
    const projected: SessionState = {
        ...state,
        prune: {
            messages: structuredClone({ ...state.prune.messages, hideConsumedIndex: undefined }),
        },
    }
    syncCompressionBlocks(projected, logger, rawMessages)
    const beforeTokens = countVisibleTokens(projected, effectiveConfig, logger, rawMessages)
    for (const target of targets) {
        deactivateCompressionTarget(
            projected.prune.messages,
            {
                ...target,
                blocks: target.blocks.map((block) =>
                    projected.prune.messages.blocksById.get(block.blockId)!,
                ),
            },
            options,
        )
    }
    syncCompressionBlocks(projected, logger, rawMessages)
    const afterTokens = countVisibleTokens(projected, effectiveConfig, logger, rawMessages)

    const contextLimit = resolveEffectiveContextLimit(state, effectiveConfig)
    const configuredReserve = effectiveConfig.compress.completionReserveTokens
    const completionReserve =
        typeof configuredReserve === "number" &&
        Number.isFinite(configuredReserve) &&
        configuredReserve >= 0
            ? configuredReserve
            : DEFAULT_COMPLETION_RESERVE_TOKENS
    return {
        beforeTokens,
        afterTokens,
        contextLimit,
        completionReserve,
        inputBudget: contextLimit ? Math.max(0, contextLimit.limit - completionReserve) : undefined,
    }
}
