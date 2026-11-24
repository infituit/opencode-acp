import type { Logger } from "../logger"
import type { SessionState, WithParts } from "./types"
import { createSessionState } from "./state"
import { getSessionRelations, loadPruneMessagesState, serializePruneMessagesState } from "./utils"
import { limitForkSourceHistory, restoreForkCompressionState } from "./rebuild"
import { fetchV2SessionMessages } from "../v2/messages"
import { parseMessageRef } from "../message-ids"
import {
    backupForkRecovery,
    loadSessionState,
    readRecoveryState,
    sameRecoveryState,
    snapshotSessionState,
    withSessionRecovery,
    writeRecoveryState,
    type PersistedSessionState,
} from "./persistence"

function emptyRecord(value: unknown): boolean {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
    )
}

/** Never infer emptiness from normalized state: loading drops malformed entries. */
export function assertEmptyForkState(persisted: PersistedSessionState): void {
    const messages = persisted?.prune?.messages
    if (
        !messages ||
        !emptyRecord(messages.blocksById) ||
        !emptyRecord(messages.byMessageId) ||
        !emptyRecord(messages.activeByAnchorMessageId) ||
        !Array.isArray(messages.activeBlockIds) ||
        messages.activeBlockIds.length !== 0 ||
        (messages.markedForCleanup !== undefined &&
            (!Array.isArray(messages.markedForCleanup) ||
                messages.markedForCleanup.length !== 0)) ||
        messages.nextBlockId !== 1 ||
        messages.nextRunId !== 1 ||
        !persisted.stats ||
        persisted.stats.pruneTokenCounter !== 0 ||
        persisted.stats.totalPruneTokens !== 0 ||
        !persisted.nudges ||
        (persisted.prune.tools !== undefined && !emptyRecord(persisted.prune.tools))
    ) {
        throw new Error(
            "Recovery requires a completely empty compression history, including inactive blocks, memberships, counters and statistics.",
        )
    }
}

function copyAliases(state: SessionState, persisted: PersistedSessionState): void {
    const ids = persisted.messageIds
    if (!ids || !Number.isInteger(ids.nextRef) || ids.nextRef < 1 || !ids.byRawId || !ids.byRef) {
        throw new Error(
            "Persisted message aliases are unavailable; recovery will not guess historical references.",
        )
    }
    state.messageIds = {
        byRawId: new Map(Object.entries(ids.byRawId)),
        byRef: new Map(Object.entries(ids.byRef)),
        nextRef: ids.nextRef,
    }
    for (const [raw, ref] of state.messageIds.byRawId) {
        const index = typeof ref === "string" ? parseMessageRef(ref) : null
        if (index === null || index >= ids.nextRef || state.messageIds.byRef.get(ref) !== raw) {
            throw new Error("Persisted message aliases are inconsistent.")
        }
    }
    for (const [ref, raw] of state.messageIds.byRef) {
        if (state.messageIds.byRawId.get(raw) !== ref)
            throw new Error("Persisted message aliases are inconsistent.")
    }
}

export async function prepareForkRecovery(
    client: any,
    sessionId: string,
    storageDir: string | undefined,
    messages: WithParts[],
    logger: Logger,
    live?: SessionState,
) {
    const before = await readRecoveryState(sessionId, storageDir)
    const persisted: PersistedSessionState = JSON.parse(before)
    assertEmptyForkState(persisted)
    if (live) {
        const snapshot = JSON.stringify(snapshotSessionState(live, persisted.sessionName))
        assertEmptyForkState(JSON.parse(snapshot))
        if (!sameRecoveryState(before, snapshot)) {
            throw new Error(
                "Live state differs from persisted state; wait for pending changes to be saved and retry.",
            )
        }
    }
    const { fork } = await getSessionRelations(client, sessionId)
    if (!fork) throw new Error("This session has no valid fork source and boundary.")

    // Replaying only compression would undo a later explicit decompression.
    // Conservatively refuse completed decompression calls except file-only exports.
    if (
        messages.some((message) =>
            message.parts.some(
                (part) =>
                    part.type === "tool" &&
                    part.tool === "acp_decompress" &&
                    part.state?.status === "completed" &&
                    !part.state.input?.toFile,
            ),
        )
    ) {
        throw new Error(
            "Decompression history is present or ambiguous; automatic source transfer is unsafe.",
        )
    }
    const source = await loadSessionState(fork.sessionID, logger, storageDir)
    if (!source) throw new Error("Fork source state is unavailable.")
    const sourceMessages = limitForkSourceHistory(
        await fetchV2SessionMessages(client, fork.sessionID),
        fork.boundary,
    )
    if (sourceMessages.length === 0)
        throw new Error("Fork boundary is unavailable; recovery refused.")

    const candidate = createSessionState()
    candidate.sessionId = sessionId
    candidate.storageDir = storageDir
    copyAliases(candidate, persisted)
    candidate.stickyTruncations = structuredClone(persisted.stickyTruncations ?? {})
    const restored = restoreForkCompressionState(
        candidate,
        messages,
        source,
        sourceMessages,
        logger,
    )
    if (restored === 0)
        throw new Error("Source blocks cannot be mapped completely within the fork boundary.")
    for (const [callId, output] of Object.entries(persisted.stickyTruncations ?? {})) {
        if (candidate.stickyTruncations[callId] !== output) {
            throw new Error("Source transfer conflicts with an existing frozen tool output.")
        }
    }
    // Existing aliases (including high-water mark) are immutable during repair.
    for (const [raw, ref] of Object.entries(persisted.messageIds!.byRawId)) {
        if (candidate.messageIds.byRawId.get(raw) !== ref)
            throw new Error("Recovery would change existing aliases.")
    }
    // Do not publish an incomplete nested graph, even for inactive descendants.
    for (const block of candidate.prune.messages.blocksById.values()) {
        for (const id of [...block.includedBlockIds, ...block.consumedBlockIds]) {
            if (!candidate.prune.messages.blocksById.has(id)) {
                throw new Error("Nested source block history is incomplete; recovery refused.")
            }
        }
    }
    const snapshot = snapshotSessionState(candidate)
    const after: PersistedSessionState = {
        ...persisted,
        prune: {
            ...persisted.prune,
            // Store the same normalized graph initialization will load, so a
            // restart alone does not make the rollback snapshot look newer.
            messages: serializePruneMessagesState(loadPruneMessagesState(snapshot.prune.messages)),
        },
        messageIds: snapshot.messageIds,
        stickyTruncations: snapshot.stickyTruncations,
        lastUpdated: snapshot.lastUpdated,
    }
    return {
        before,
        after,
        sourceId: fork.sessionID,
        restored,
        active: candidate.prune.messages.activeBlockIds.size,
    }
}

export async function applyForkRecovery(
    sessionId: string,
    storageDir: string | undefined,
    plan: Awaited<ReturnType<typeof prepareForkRecovery>>,
    unchanged: () => boolean,
    invalidate: () => void = () => {},
) {
    return withSessionRecovery(sessionId, storageDir, async () => {
        const check = async () => {
            if (!unchanged() || (await readRecoveryState(sessionId, storageDir)) !== plan.before) {
                throw new Error(
                    "Session changed during recovery. No recovery applied; preview again while idle.",
                )
            }
        }
        await check()
        const backup = await backupForkRecovery(sessionId, storageDir, plan.before, plan.after)
        await check()
        try {
            await writeRecoveryState(sessionId, storageDir, JSON.stringify(plan.after, null, 2))
            if (
                !unchanged() ||
                !sameRecoveryState(
                    await readRecoveryState(sessionId, storageDir),
                    JSON.stringify(plan.after),
                )
            ) {
                throw new Error("Session changed while committing recovery.")
            }
        } catch (error) {
            // A host set may fail after committing. Keep the backup and make the
            // failure actionable instead of publishing a candidate into memory.
            invalidate()
            throw new Error(
                `Recovery could not be confirmed. Backup: ${backup.path}; rollback: /acp recover-fork --rollback ${backup.id}. ${error instanceof Error ? error.message : String(error)}`,
            )
        }
        invalidate()
        return backup
    })
}
