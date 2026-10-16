/**
 * [Issue #485] Sticky emergency truncation.
 *
 * The emergency guards (`truncateLargeToolOutputs` + `enforceContextBudget`)
 * operate on a fresh pristine copy of `output.messages` every request and
 * gate on the LAST assistant's reported usage — which reflects the
 * *truncated* request, not the pristine one. A session hovering at the guard
 * threshold therefore oscillates: truncate (A→B) → smaller usage → no
 * truncation next request (full A restored) → cache miss → over budget
 * again. Every flip invalidates the provider prefix cache from that message
 * onward, and with opencode auto-retrying on a busy backend the churn can
 * take down the serving cluster.
 *
 * Stickiness makes the guard decision one-way: the first time a guard
 * truncates (or clears) a tool output, the result is frozen in
 * `state.stickyTruncations` keyed by tool call ID and replayed verbatim on
 * every later request BEFORE the guards run. A→B→B→B — the truncated form
 * never grows back. The full content stays in the session store (and on
 * disk), so nothing is lost; the wire view is simply stable.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"

type ToolPartLike = {
    type: string
    callID?: unknown
    state?: { output?: unknown }
}

function collectToolParts(messages: WithParts[]): ToolPartLike[] {
    const parts: ToolPartLike[] = []
    for (const message of messages) {
        const messageParts = Array.isArray((message as { parts?: unknown }).parts)
            ? ((message as { parts: unknown[] }).parts as unknown[])
            : []
        for (const part of messageParts) {
            if ((part as ToolPartLike)?.type === "tool") {
                parts.push(part as ToolPartLike)
            }
        }
    }
    return parts
}

/**
 * Replay frozen truncations onto the request copy, and prune entries whose
 * call no longer exists in the session (message deleted externally).
 */
export function applyStickyTruncations(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): void {
    const frozen = state.stickyTruncations
    if (Object.keys(frozen).length === 0) return

    let replayed = 0
    const seen = new Set<string>()
    for (const part of collectToolParts(messages)) {
        const callID = typeof part.callID === "string" ? part.callID : undefined
        if (!callID) continue
        seen.add(callID)
        const recorded = frozen[callID]
        if (recorded === undefined) continue
        if (typeof part.state?.output !== "string" || part.state.output === recorded) continue
        part.state.output = recorded
        replayed++
    }

    for (const callID of Object.keys(frozen)) {
        if (!seen.has(callID)) delete frozen[callID]
    }

    if (replayed > 0) {
        logger.debug("Sticky truncation: replayed frozen tool outputs", {
            replayed,
            frozen: Object.keys(frozen).length,
        })
    }
}

/** Snapshot callID → output for every tool part with a string output. */
export function snapshotToolOutputs(messages: WithParts[]): Map<string, string> {
    const snapshot = new Map<string, string>()
    for (const part of collectToolParts(messages)) {
        const callID = typeof part.callID === "string" ? part.callID : undefined
        if (!callID) continue
        if (typeof part.state?.output !== "string") continue
        snapshot.set(callID, part.state.output)
    }
    return snapshot
}

/**
 * Freeze any output the guards changed since `before`: a changed output is
 * either a fresh truncation or a phase-2 clear — both must stick.
 */
export function recordStickyTruncations(
    state: SessionState,
    messages: WithParts[],
    before: Map<string, string>,
    logger: Logger,
): void {
    let recorded = 0
    for (const part of collectToolParts(messages)) {
        const callID = typeof part.callID === "string" ? part.callID : undefined
        if (!callID) continue
        if (typeof part.state?.output !== "string") continue
        const prior = before.get(callID)
        if (prior === undefined || prior === part.state.output) continue
        if (state.stickyTruncations[callID] === part.state.output) continue
        state.stickyTruncations[callID] = part.state.output
        recorded++
    }
    if (recorded > 0) {
        logger.info("Sticky truncation: froze truncated tool outputs", { recorded })
    }
}
