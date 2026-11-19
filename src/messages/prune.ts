import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isHostInput, isUserPrompt } from "./query"
import { createSyntheticUserMessage } from "./utils"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    filterCompressedRanges(state, messages)
    stripStepMarkers(messages)
}

const MAX_STEP_FINISH_REASON = 50

const stripStepMarkers = (messages: WithParts[]): void => {
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        let changed = false
        const filtered: typeof parts = []

        for (const part of parts) {
            if (part.type === "step-start") {
                changed = true
                continue
            }

            if (part.type === "step-finish") {
                const reason = (part as { reason?: unknown }).reason
                if (typeof reason === "string" && reason.length > MAX_STEP_FINISH_REASON) {
                    const truncated = reason.slice(0, MAX_STEP_FINISH_REASON) + "..."
                    // Skip when already truncated: keeps `changed` false on idempotent
                    // re-runs so the parts array reference (and prefix cache) stays stable.
                    if (truncated !== reason) {
                        filtered.push({ ...part, reason: truncated })
                        changed = true
                        continue
                    }
                }
            }

            filtered.push(part)
        }

        if (changed) {
            msg.parts = filtered
        }
    }
}

const filterCompressedRanges = (state: SessionState, messages: WithParts[]): void => {
    if (state.prune.messages.byMessageId.size === 0) {
        return
    }

    const survive: boolean[] = messages.map((msg) => {
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        if (!pruneEntry || pruneEntry.activeBlockIds.length === 0) {
            return true
        }
        return false
    })

    // Preserve the original human task, not a host-delivered handoff payload.
    const firstUserIdx = messages.findIndex(isUserPrompt)
    if (firstUserIdx >= 0) {
        survive[firstUserIdx] = true
    }

    const result: WithParts[] = []
    for (let i = 0; i < messages.length; i++) {
        if (survive[i]) {
            result.push(messages[i]!)
        }
    }

    // Some providers require a user-role message. If compression removed the
    // only host delivery, satisfy the wire contract without resurrecting it.
    if (!result.some((message) => message.info.role === "user")) {
        const compressedHostInput = messages.find(
            (message, index) => !survive[index] && isHostInput(message),
        )
        if (compressedHostInput) {
            result.unshift(
                createSyntheticUserMessage(
                    compressedHostInput,
                    "Earlier host input has been compressed.",
                    "acp-compressed-host-input",
                ),
            )
        }
    }

    messages.length = 0
    messages.push(...result)
}
