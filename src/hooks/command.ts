import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { SessionStateRegistry } from "../state"
import { handleContextCommand, handleStatsCommand } from "../commands"
import { handleExportCommand } from "../commands/export"
import { sendIgnoredMessage } from "../ui/notification"
import type { HostPermissionSnapshot } from "../host-permissions"
import { syncCompressPermissionState } from "../compress-permission"
import { fetchSessionMessages } from "../compress/search"

function buildHelpText(): string {
    return [
        "[ACP] Available commands:",
        "",
        "  /acp              Show compression status (same as /acp stats)",
        "  /acp context      Token usage breakdown (system, user, assistant, tools)",
        "  /acp stats        Compression status: blocks, context usage, ranges",
        "  /acp export       Export active compression blocks to markdown",
        "                   Options: --output <path>, --tier t1,t2,t3, --stdout, --append",
        "  /acp help         Show this help",
    ].join("\n")
}

export function createCommandExecuteHandler(
    client: any,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "acp") {
            const messages = await fetchSessionMessages(client, input.sessionID)

            const state = await registry.getOrCreate(client, input.sessionID, messages, config)

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
                workingDirectory,
            }

            // [FIX #398] Every handled /acp branch MUST abort the command by throwing
            // __ACP_CONTEXT_HANDLED__. A normal return does NOT stop execution:
            // opencode's Plugin.trigger only aborts on hook errors, and the command is
            // registered with template: "" (no $ARGUMENTS), so opencode appends the raw
            // arguments to the empty template and sends them to the model as a user
            // message ("/acp status" leaked "status" to the model in v1.17.0+). The
            // resulting level=ERROR log line on opencode >= 1.18.18 is the known cost
            // of this mechanism (#296) — do NOT replace these throws with returns.
            const sub = input.arguments?.trim().toLowerCase()
            if (sub === "stats" || sub === "status" || sub === "") {
                await handleStatsCommand(commandCtx)
                throw new Error("__ACP_CONTEXT_HANDLED__")
            }

            if (sub === "export" || sub.startsWith("export ")) {
                const exportArgs = input.arguments?.trim().slice("export".length).trim() || ""
                await handleExportCommand(commandCtx, exportArgs)
                throw new Error("__ACP_CONTEXT_HANDLED__")
            }

            if (sub === "help") {
                await sendIgnoredMessage(client, input.sessionID, buildHelpText(), {}, logger)
                throw new Error("__ACP_CONTEXT_HANDLED__")
            }

            await handleContextCommand(commandCtx)
            throw new Error("__ACP_CONTEXT_HANDLED__")
        }
    }
}
