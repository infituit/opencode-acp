import type {
    Info as V2ToolInfo,
    ToolContext as V2ToolContext,
} from "@opencode/plugin/promise/tool"
import type { CompressionBlock } from "../state/types"
import { type ToolFactoryContext, resolveToolContext } from "./types"

function formatCoverage(block: CompressionBlock): string {
    const count = block.effectiveMessageIds?.length || 0
    return count > 0 ? `${count} message${count !== 1 ? "s" : ""}` : "—"
}

const RECAP_TOOL_DESCRIPTION = `Read-only retrieval of compression block summaries.

Call this tool to re-fetch a specific block's summary without decompressing the full original content. Useful when a past compress tool call's summary has scrolled out of context or was truncated by the provider.

Args:
- blockId: optional block number (e.g., 5). If omitted, lists all active blocks with brief info.`

export function createAcpContextRecapToolV2(factoryCtx: ToolFactoryContext): V2ToolInfo {
    factoryCtx.prompts.reload()

    return {
        name: "acp_context_recap",
        description: RECAP_TOOL_DESCRIPTION,
        input: {
            type: "object",
            properties: {
                blockId: {
                    type: "number",
                    description:
                        "Block number to retrieve (e.g., 5). If omitted, lists all active blocks.",
                },
            },
            additionalProperties: false,
        },
        async execute(input, toolCtx: V2ToolContext) {
            const ctx = resolveToolContext(factoryCtx, toolCtx.sessionID)
            const blockId =
                input && typeof input === "object" && "blockId" in input
                    ? (input as { blockId?: number }).blockId
                    : undefined
            const msgState = ctx.state.prune.messages
            const activeIds = Array.from(msgState.activeBlockIds).sort((a, b) => a - b)

            if (activeIds.length === 0) {
                return { content: "No active compression blocks." }
            }

            if (blockId !== undefined) {
                const block = msgState.blocksById.get(blockId)
                if (!block) {
                    return {
                        content: `Block b${blockId} not found. Active blocks: ${activeIds.map((id) => `b${id}`).join(", ")}`,
                    }
                }
                if (!block.active) {
                    return {
                        content: `Block b${blockId} is inactive (deactivated by GC or nested compression).`,
                    }
                }
                const range = formatCoverage(block)
                return {
                    content: `[Compressed conversation section]\n${block.summary}\n\n[Block b${blockId} | ${range} | topic: "${block.topic || "(none)"}"]`,
                }
            }

            const lines: string[] = [`Active compression blocks (${activeIds.length}):`]
            for (const id of activeIds) {
                const block = msgState.blocksById.get(id)
                if (!block || !block.active) continue
                const range = formatCoverage(block)
                const summaryPreview = block.summary.slice(0, 200)
                lines.push(`\nb${id} | ${range} | "${block.topic || "(none)"}"`)
                lines.push(`  ${summaryPreview}${block.summary.length > 200 ? "..." : ""}`)
            }
            lines.push(
                `\nCall with blockId to get the full summary: acp_context_recap({ blockId: N })`,
            )
            return { content: lines.join("\n") }
        },
    }
}
