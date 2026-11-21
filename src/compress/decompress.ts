import type {
    Info as V2ToolInfo,
    ToolContext as V2ToolContext,
} from "@opencode/plugin/promise/tool"
import { type ToolContext, type ToolFactoryContext, resolveToolContext } from "./types"
import type { CompressionTarget } from "../commands/compression-targets"
import type { CompressionBlock } from "../state/types"
import type { SessionState, WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { syncCompressionBlocks } from "../messages"
import { extractToolContent } from "../context-usage"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectDecompression } from "./decompress-budget"
import {
    fetchSessionMessages,
    buildSearchContext,
    resolveBoundaryIds,
    resolveSelection,
} from "./search"
import { resolveCompressionTarget } from "../commands/compression-targets"
import {
    parseBlockIdArg,
    resolveDecompressMode,
    findActiveAncestorBlockId,
    findActiveBlocksOverlappingMessages,
    snapshotActiveMessages,
    deactivateCompressionTarget,
    computeRestoredMessages,
    computeReactivatedBlockIds,
    buildRestoredContentPreview,
    checkDecompressSourceAvailability,
} from "./decompress-logic"
import { formatTokenCount } from "../ui/utils"

interface RunContext {
    sessionID: string
}

async function prepareDecompressSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<{ rawMessages: WithParts[] }> {
    await ctx.assertPermission(toolCtx.sessionID)

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config,
    )

    assignMessageRefs(ctx.state, rawMessages)

    return { rawMessages }
}

async function finalizeDecompressSession(ctx: ToolContext): Promise<void> {
    await saveSessionState(ctx.state, ctx.logger)
}

type ResolveResult = { ok: true; targets: CompressionTarget[] } | { ok: false; error: string }

function resolveTargets(
    args: Record<string, unknown>,
    state: SessionState,
    rawMessages: WithParts[],
    logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
): ResolveResult {
    const mode = resolveDecompressMode(args)
    if (!mode.ok) {
        return { ok: false, error: `Error: ${mode.error}` }
    }

    const messagesState = state.prune.messages

    if (mode.mode === "block") {
        return resolveSingleBlockTarget(messagesState, args.blockId as string)
    }

    return resolveRangeTarget(
        state,
        rawMessages,
        args.startId as string,
        args.endId as string,
        logger,
    )
}

function resolveSingleBlockTarget(
    messagesState: SessionState["prune"]["messages"],
    blockIdArg: string,
): ResolveResult {
    const targetBlockId = parseBlockIdArg(blockIdArg)
    if (targetBlockId === null) {
        return {
            ok: false,
            error: `Error: Invalid block ID "${blockIdArg}". Use format "b0", "b1", etc.`,
        }
    }

    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        return {
            ok: false,
            error: `Error: Block ${targetBlockId} does not exist. No compression found with that ID.`,
        }
    }

    // Keep nested-redirect (consumed blocks must go through parent) but drop the
    // "not active" rejection — inactive standalone blocks can be decompressed.
    const activeBlocks = target.blocks.filter((block) => block.active)
    if (activeBlocks.length === 0) {
        const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
        if (activeAncestorBlockId !== null) {
            return {
                ok: false,
                error: `Error: Block ${target.displayId} is nested inside active block ${activeAncestorBlockId}. Decompress block ${activeAncestorBlockId} first.`,
            }
        }
    }

    return { ok: true, targets: [target] }
}

function resolveRangeTarget(
    state: SessionState,
    rawMessages: WithParts[],
    startId: string,
    endId: string,
    logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
): ResolveResult {
    const searchContext = buildSearchContext(state, rawMessages)

    let startReference
    let endReference
    try {
        const resolved = resolveBoundaryIds(searchContext, state, startId, endId)
        startReference = resolved.startReference
        endReference = resolved.endReference
    } catch (err) {
        return { ok: false, error: `Error: ${(err as Error).message}` }
    }

    let selection
    try {
        selection = resolveSelection(searchContext, startReference, endReference)
    } catch (err) {
        return { ok: false, error: `Error: ${(err as Error).message}` }
    }
    if (selection.messageIds.length === 0) {
        return {
            ok: false,
            error: `Error: No messages found in range ${startId}..${endId}.`,
        }
    }

    const messageIdSet = new Set(selection.messageIds)
    const messagesState = state.prune.messages
    const overlappingBlocks = findActiveBlocksOverlappingMessages(messagesState, messageIdSet)
    if (overlappingBlocks.length === 0) {
        return {
            ok: false,
            error: `Error: No active compression blocks overlap the range ${startId}..${endId}. The content may already be fully visible. Use acp_status to review block coverage.`,
        }
    }

    const targetMap = new Map<number, CompressionTarget>()
    for (const block of overlappingBlocks) {
        const target = resolveCompressionTarget(messagesState, block.blockId)
        if (target) {
            targetMap.set(target.displayId, target)
        }
    }
    const targets = Array.from(targetMap.values())

    logger.info("range decompress resolved", {
        range: `${startId}..${endId}`,
        matchedBlocks: overlappingBlocks.map((b) => b.blockId),
        targets: targets.map((t) => t.displayId),
    })

    return { ok: true, targets }
}

const TOOL_DESCRIPTION = `Restores previously compressed content.

Use this tool when you need exact details from compressed content that the summary cannot provide.
The tool returns a condensed preview of the restored content so you can reason about it immediately.

TWO MODES:

1. Block mode (default): decompress a single block by ID.
   - blockId: block reference to decompress (e.g., "b0", "b2")

2. Range mode: decompress ALL blocks overlapping a message range. Use this to restore
   content across multiple blocks without calling acp_status + decompress repeatedly.
   - startId: starting message or block ref (e.g., "m00150")
   - endId: ending message or block ref (e.g., "m00200")

   Range mode finds every active block whose effectiveMessageIds touch the range and
   batch-restores them. Partial overlap decompresses the whole block (content cannot be
   partially restored). Nested blocks are handled automatically.

ARGUMENTS:
- blockId?: string — use this OR startId+endId (mutually exclusive)
- startId?: string — range start (message or block ref)
- endId?: string — range end (message or block ref)
- toFile?: string — if provided, writes restored content to this file path (must be under
  /tmp or ~/.cache/opencode/) instead of inflating context. Block(s) stay compressed.

IMPORTANT:
- Direct restoration is preflighted against the effective context window minus the completion
  reserve. If it would grow text context beyond this budget, blocks stay compressed and the tool
  returns an executable toFile call instead. It does not write a file automatically.
- Prefer toFile for large blocks: search the exported file for relevant keywords, then read a
  small section with offset and limit. Do not load the entire export back into context.
- Budget estimates cover visible text and reasoning, not exact provider or native media costs.
- Message-mode blocks from the same batch (same runId) are restored together.
- TIER-AWARE: by default, decompressing a multi-tier block restores the PREVIOUS tier's
  summaries (e.g., decompress T2 → T1 summaries visible, not raw messages). Use full:true
  to restore all the way to original messages (can be very expensive for T2/T3 blocks).
- After decompression, the restored content will appear in full in your next context window.
- Do NOT call this tool in parallel with compress — their state mutations may conflict.`

function buildSchema() {
    return {
        type: "object",
        properties: {
            blockId: {
                type: "string",
                description:
                    'Block reference to decompress (e.g., "b0", "b2"). Mutually exclusive with startId/endId.',
            },
            startId: {
                type: "string",
                description:
                    'Range start: message ref (e.g., "m00150") or block ref (e.g., "b2"). Used with endId.',
            },
            endId: {
                type: "string",
                description:
                    'Range end: message ref (e.g., "m00200") or block ref (e.g., "b5"). Used with startId.',
            },
            toFile: {
                type: "string",
                description:
                    "If provided, writes restored content to this file path instead of inflating context. Block stays compressed. Path must be under /tmp or ~/.cache/opencode/.",
            },
            full: {
                type: "boolean",
                description:
                    "If true, restores ALL content down to original messages (multi-level decompress). Default: false.",
            },
        },
        additionalProperties: false,
    }
}

function extractMessageId(m: WithParts): string {
    return m?.info?.id ?? ""
}

type MessagePart = WithParts["parts"][number]

// Only text and completed tool parts carry user-facing content; other structural
// parts (reasoning, step markers) are skipped. Tool output reuses extractToolContent
// so exported text matches what token-utils counts.
function serializeMessagePart(part: MessagePart): string | null {
    if (!part || typeof part !== "object") return null
    if (part.type === "text") {
        return typeof part.text === "string" && part.text.length > 0 ? part.text : null
    }
    if (part.type === "tool") {
        const contents = extractToolContent(part)
        if (contents.length === 0) return null
        const toolName =
            "tool" in part && typeof part.tool === "string" && part.tool.length > 0
                ? part.tool
                : "tool"
        return `[${toolName}] ${contents.join("\n")}`
    }
    return null
}

function extractMessageText(m: WithParts): string {
    const role = m?.info?.role ?? "unknown"
    const parts = Array.isArray(m.parts) ? m.parts : []
    const segments: string[] = []
    for (const part of parts) {
        const serialized = serializeMessagePart(part)
        if (serialized !== null) segments.push(serialized)
    }
    return `[${role}]\n${segments.join("\n\n")}`
}

export function createDecompressTool(factoryCtx: ToolFactoryContext): V2ToolInfo {
    return {
        name: "acp_decompress",
        description: TOOL_DESCRIPTION,
        input: buildSchema(),
        async execute(input, toolCtx: V2ToolContext) {
            const args = input as {
                blockId?: string
                startId?: string
                endId?: string
                toFile?: string
                full?: boolean
            }
            const ctx = resolveToolContext(factoryCtx, toolCtx.sessionID)
            const { rawMessages } = await prepareDecompressSession(ctx, toolCtx)

            const resolved = resolveTargets(
                args as Record<string, unknown>,
                ctx.state,
                rawMessages,
                ctx.logger,
            )
            if (!resolved.ok) {
                return { content: resolved.error }
            }
            const targets = resolved.targets

            const messagesState = ctx.state.prune.messages
            const activeBlocks: CompressionBlock[] = []
            for (const target of targets) {
                for (const block of target.blocks) {
                    if (block.active) {
                        activeBlocks.push(block)
                    }
                }
            }

            if (args.toFile) {
                const targetPath = args.toFile as string
                const os = await import("os")
                const path = await import("path")
                const allowedDirs = [
                    os.tmpdir() + "/",
                    path.join(os.homedir(), ".cache", "opencode") + "/",
                ]
                const resolvedPath = path.resolve(targetPath)
                const isAllowed = allowedDirs.some((dir) => {
                    const rel = path.relative(dir, resolvedPath)
                    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
                })
                if (!isAllowed) {
                    return {
                        content: `Error: toFile path must be under ${os.tmpdir()} or ~/.cache/opencode/. Got: ${targetPath}`,
                    }
                }

                const msgIdSet = new Set<string>()
                for (const block of activeBlocks) {
                    for (const id of block.effectiveMessageIds ?? []) {
                        msgIdSet.add(id)
                    }
                }
                const blockMessages = rawMessages.filter((m) => msgIdSet.has(extractMessageId(m)))
                const lines = blockMessages.map(extractMessageText)
                const { writeFile } = await import("fs/promises")

                let fileContent: string
                let sourceNote: string
                if (lines.length > 0) {
                    fileContent = lines.join("\n\n---\n\n")
                    sourceNote = `${blockMessages.length} original message${blockMessages.length === 1 ? "" : "s"}`
                } else {
                    // Originals are absent when the block's history is gone (inactive /
                    // consumed block) — fall back to the stored summary.
                    fileContent = targets[0]?.blocks[0]?.summary ?? "(no content available)"
                    sourceNote = `no original messages found; wrote block summary (${targets.length} block${targets.length === 1 ? "" : "s"})`
                }
                await writeFile(targetPath, fileContent, "utf-8")

                const displayIds = targets.map((t) => `b${t.displayId}`).join(", ")
                return {
                    content: `Block(s) ${displayIds} content (${sourceNote}, ${fileContent.length} chars) written to ${targetPath}. Block(s) stay compressed — context unchanged. Search the exported file for relevant keywords, then use read with offset and limit to inspect specific sections. Do not read the entire file back into context.`,
                }
            }

            // [Issue #446] Fail closed when host history no longer contains the
            // originals this decompression would restore. A transient fetch failure
            // already threw in prepareDecompressSession; reaching here with IDs
            // missing means they were deleted/compacted away — deactivating anyway
            // would report phantom restorations and discard summary coverage
            // irreversibly. No state is mutated before this check.
            const availability = checkDecompressSourceAvailability(
                messagesState,
                targets,
                { full: args.full === true },
                new Set(rawMessages.map((m) => m.info.id)),
            )
            if (availability.missingMessageIds.length > 0) {
                const displayIds = targets.map((t) => `b${t.displayId}`).join(", ")
                const missingRefs = availability.missingMessageIds.map(
                    (id) => ctx.state.messageIds.byRawId.get(id) ?? id,
                )
                const shownRefs = missingRefs.slice(0, 10).join(", ")
                const extraCount = missingRefs.length - Math.min(missingRefs.length, 10)
                ctx.logger.warn("Decompress aborted: source messages missing from host history", {
                    targetDisplayIds: displayIds,
                    full: args.full === true,
                    requiredCount: availability.requiredMessageIds.length,
                    missingCount: availability.missingMessageIds.length,
                    missingRefs,
                })
                return {
                    content:
                        `Error: Cannot decompress ${displayIds}: ${availability.missingMessageIds.length} of ` +
                        `${availability.requiredMessageIds.length} source message(s) are no longer present in session ` +
                        `history (removed by native compaction or external deletion). Missing: ${shownRefs}` +
                        (extraCount > 0 ? ` (+${extraCount} more)` : "") +
                        `. Block(s) stay compressed — the summary remains available and nothing was changed. ` +
                        `This is a missing-source condition, not a transient fetch failure.`,
                }
            }

            const projection = projectDecompression(
                ctx.state,
                ctx.config,
                ctx.logger,
                rawMessages,
                targets,
                { full: args.full === true },
            )
            if (
                projection.inputBudget !== undefined &&
                projection.afterTokens > projection.inputBudget &&
                projection.afterTokens > projection.beforeTokens
            ) {
                const displayIds = targets.map((t) => `b${t.displayId}`).join(", ")
                const exportArgs = {
                    ...(typeof args.blockId === "string" && args.blockId.trim() !== ""
                        ? { blockId: args.blockId }
                        : { startId: args.startId, endId: args.endId }),
                    ...(args.full === true ? { full: true } : {}),
                    toFile: join(tmpdir(), `acp-decompress-b${targets[0]!.displayId}.txt`),
                }
                ctx.logger.warn("Decompress deferred: projected context exceeds input budget", {
                    targetDisplayIds: displayIds,
                    full: args.full === true,
                    ...projection,
                })
                return {
                    content:
                        `Direct context restoration deferred for ${displayIds}: estimated text context would grow ` +
                        `from ~${formatTokenCount(projection.beforeTokens)} to ~${formatTokenCount(projection.afterTokens)}, ` +
                        `exceeding the ${projection.inputBudget}-token input budget ` +
                        `(context window ${projection.contextLimit!.limit}, ${projection.contextLimit!.source}; ` +
                        `completion reserve ${projection.completionReserve}). ` +
                        `Native media token costs are not included in this estimate.\n` +
                        `Block(s) stay compressed; compression state and statistics are unchanged. No file was written.\n\n` +
                        `Next step: call acp_decompress with toFile to export without inflating context:\n` +
                        JSON.stringify(exportArgs) +
                        `\nThen search the exported file for relevant keywords, or use read with offset and limit ` +
                        `to inspect a small section. Do not read the whole file back into context.` +
                        (args.full
                            ? ` You can also omit full:true to restore only the previous tier if it fits.`
                            : ""),
                }
            }

            const activeMessagesBefore = snapshotActiveMessages(messagesState)
            const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

            for (const target of targets) {
                deactivateCompressionTarget(messagesState, target, { full: args.full === true })
            }

            syncCompressionBlocks(ctx.state, ctx.logger, rawMessages)

            const { restoredMessageCount, restoredTokens } = computeRestoredMessages(
                messagesState,
                activeMessagesBefore,
            )
            const reactivatedBlockIds = computeReactivatedBlockIds(
                messagesState,
                activeBlockIdsBefore,
            )

            ctx.state.stats.totalPruneTokens = Math.max(
                0,
                ctx.state.stats.totalPruneTokens - restoredTokens,
            )

            await finalizeDecompressSession(ctx)

            const restoredContentPreview = buildRestoredContentPreview(
                rawMessages,
                activeMessagesBefore,
                messagesState,
            )

            const displayIds = targets.map((t) => `b${t.displayId}`).join(", ")
            const lines: string[] = []
            const headerNoun = targets.length === 1 ? "block" : "blocks"
            lines.push(
                `Decompressed ${headerNoun} ${displayIds}. Restored ${restoredMessageCount} message(s) (~${formatTokenCount(restoredTokens)}).`,
            )

            if (projection.contextLimit) {
                const before = Math.round(
                    (projection.beforeTokens / projection.contextLimit.limit) * 100,
                )
                const after = Math.round(
                    (projection.afterTokens / projection.contextLimit.limit) * 100,
                )
                lines.push(
                    `Context usage: ${before}% → ${after}% (estimated text; excludes native media costs).`,
                )
            }

            if (reactivatedBlockIds.length > 0) {
                const refs = reactivatedBlockIds.map((id) => `b${id}`).join(", ")
                lines.push(`Also restored nested block(s): ${refs}.`)
            }

            if (restoredContentPreview) {
                lines.push("")
                lines.push("RESTORED CONTENT (condensed):")
                lines.push(restoredContentPreview)
            }

            ctx.logger.info("Decompress tool completed", {
                mode: typeof args.startId === "string" ? "range" : "block",
                targetBlockIds: targets.map((t) => t.displayId),
                restoredMessageCount,
                restoredTokens,
                reactivatedBlockIds,
            })

            return { content: lines.join("\n") }
        },
    }
}
