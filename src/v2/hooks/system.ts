import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { renderSystemPrompt, type PromptStore } from "../../prompts"
import { buildProtectedToolsExtension } from "../../prompts/extensions/system"
import { compressPermission } from "../../compress-permission"
import { saveSessionState, type SessionStateRegistry } from "../../state"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

export function createSystemPromptHandler(
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: {
            sessionID?: string
            model: {
                id?: string
                providerID?: string
                limit: { context: number; input?: number; output?: number }
            }
        },
        output: { system: string[] },
    ) => {
        // [FIX #312] Record the live limit for this model BEFORE the state
        // guard below: the catalog is stateless and must keep accepting
        // entries even when the session state has not been created yet, so
        // the messages hook can reconcile a model switch on its next call.
        registry.recordModelLimit(
            input.model?.providerID,
            input.model?.id,
            input.model?.limit?.context,
        )

        // messages.transform creates the session state before this fires; if
        // absent (internal-agent early-return), there is nothing to attribute.
        const state = input.sessionID ? registry.get(input.sessionID) : undefined

        if (!state || (state.isSubAgent && !config.allowSubAgents)) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping ACP system prompt injection for internal agent")
            return
        }

        // [FIX #346] Attribute the limit to the session only for real session
        // requests: internal agents (title/summary/compaction) may run on a
        // different model and must not overwrite the session's limit.
        // Persist on change so a freshly spawned process (headless
        // spawn+resume) resumes with the limit already known — the system
        // hook is the only writer and fires AFTER messages.transform within
        // a request, so without this the limit is learned and lost every
        // message and the safety net never engages.
        if (input.model?.limit?.context) {
            const limit = input.model.limit.context
            const providerID = input.model?.providerID
            const modelID = input.model?.id
            // Identity fields are only written when present: a limit without
            // identity must not clobber the pair the messages hook relies on
            // for staleness detection (#312).
            const changed =
                state.modelContextLimit !== limit ||
                (providerID !== undefined && state.modelProviderID !== providerID) ||
                (modelID !== undefined && state.modelID !== modelID)
            state.modelContextLimit = limit
            // [FIX #312 follow-up] Record WHICH model the limit belongs to so
            // the messages hook can detect staleness on a catalog miss.
            if (providerID !== undefined) {
                state.modelProviderID = providerID
            }
            if (modelID !== undefined) {
                state.modelID = modelID
            }
            if (changed) {
                saveSessionState(state, logger).catch(() => {})
            }
        }

        const effectivePermission = compressPermission(state, config)

        if (effectivePermission === "deny") {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        const newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            state.isSubAgent && config.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}
