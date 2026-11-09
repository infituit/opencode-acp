import type { Logger } from "../logger"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    resolveCompressionDuration,
} from "../compress/timing"
import { saveSessionState, type SessionStateRegistry } from "../state"
import { clearSmartPlanSession } from "../compress/smart-plan"

export function createEventHandler(registry: SessionStateRegistry, logger: Logger) {
    return async (input: { event: any }) => {
        if (input.event?.type === "session.idle" || input.event?.type === "session.deleted") {
            const sessionID =
                input.event?.properties?.sessionID ?? input.event?.properties?.info?.id
            if (typeof sessionID === "string") clearSmartPlanSession(sessionID)
            return
        }
        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "acp_compress") {
            return
        }

        // [FIX #33] The event hook carries no sessionID. compressionTiming is
        // shared on the registry so record/consume use one map (a per-session map
        // would let the destructive consume delete the start in the wrong
        // session). The apply step iterates sessions; only the owner matches.
        const timing = registry.compressionTiming

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (timing.startsByCallId.has(key)) {
                return
            }
            timing.startsByCallId.set(key, startedAt)
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = timing.startsByCallId.get(key)
            timing.startsByCallId.delete(key)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            timing.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            for (const state of registry.all()) {
                const updates = applyPendingCompressionDurations(state)
                if (updates > 0) {
                    await saveSessionState(state, logger)
                    logger.info("Attached compression time to blocks", {
                        messageID: part.messageID,
                        callID: part.callID,
                        blocks: updates,
                        durationMs,
                    })
                }
            }
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            timing.startsByCallId.delete(buildCompressionTimingKey(part.messageID, part.callID))
        }
    }
}
