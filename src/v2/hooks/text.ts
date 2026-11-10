import type { Logger } from "../../logger"
import { stripHallucinationsFromString, stripLeakedTrailingRefs } from "../../messages"
import type { SessionStateRegistry } from "../../state"

export function createTextCompleteHandler(registry: SessionStateRegistry, logger: Logger) {
    return async (
        input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        if (typeof output.text !== "string" || output.text.length === 0) {
            return
        }

        let text = stripHallucinationsFromString(output.text)

        // [#431] Bare refs carry no tag — catch the self-echo variant where the
        // model leaks its own not-yet-assigned ref as a trailing fragment.
        // registry.get is a synchronous in-memory lookup (no client fetch); on
        // a miss (soft-cap eviction, internal title/summary sessions) the step
        // is skipped and behavior falls back to tag-only sanitization.
        const state =
            typeof input.sessionID === "string" ? registry.get(input.sessionID) : undefined
        if (state) {
            const nextBlockId = state.prune?.messages?.nextBlockId
            const stripped = stripLeakedTrailingRefs(text, {
                nextMessageRef: Number.isInteger(state.messageIds.nextRef)
                    ? state.messageIds.nextRef
                    : null,
                nextBlockRef: Number.isInteger(nextBlockId) ? nextBlockId : null,
            })
            if (stripped !== text) {
                logger.warn("Stripped leaked trailing ACP ref from assistant output", {
                    sessionID: input.sessionID,
                    messageID: input.messageID,
                    removedChars: text.length - stripped.length,
                    removedTailPreview: text.slice(stripped.length, stripped.length + 200),
                })
                text = stripped
            }
        }

        output.text = text
    }
}
