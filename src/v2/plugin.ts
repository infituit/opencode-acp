import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { getConfig } from "../config"
import {
    createAcpContextRecapToolV2,
    createAcpStatusToolV2,
    createCompressRangeTool,
    createDecompressTool,
    createSearchContextToolV2,
} from "../compress"
import { Logger } from "../logger"
import { diagnoseContext } from "../diagnostics"
import { SessionStateRegistry } from "../state"
import { configureNativeStateStorage } from "../state/persistence"
import { PromptStore } from "../prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
} from "../hooks"
import type { HostPermissionSnapshot } from "../host-permissions"
import { startAutoUpdate } from "../update"
import { fetchV2SessionMessages, toV2RequestMessages } from "./messages"

async function findV2ToolName(
    ctx: Context,
    sessionID: string,
    callID: string,
): Promise<string | undefined> {
    const messages = await ctx.session.context({ sessionID })
    for (const message of messages as Array<{ type?: string; content?: unknown[] }>) {
        if (message.type !== "assistant") continue
        for (const part of message.content ?? []) {
            if (!part || typeof part !== "object") continue
            const tool = part as { type?: string; id?: string; name?: string }
            if ((tool.type === "tool" || tool.type === "tool-call") && tool.id === callID) {
                return tool.name
            }
        }
    }
    return undefined
}

async function notifySession(ctx: Context, title: string, message: string): Promise<void> {
    try {
        const response = await ctx.session.list()
        const sessions = Array.isArray(response)
            ? response
            : ((response as { data?: unknown }).data ?? [])
        const sessionID =
            Array.isArray(sessions) &&
            typeof (sessions[0] as { id?: unknown } | undefined)?.id === "string"
                ? (sessions[0] as { id: string }).id
                : undefined
        if (sessionID) {
            await ctx.session.synthetic({ sessionID, text: message, description: title })
        }
    } catch {
        // Configuration warnings must never prevent plugin startup.
    }
}

function asV2Model(model: { providerID: string; id: string }) {
    return {
        id: model.id,
        providerID: model.providerID,
        limit: { context: 0 },
    }
}

async function registerTools(
    ctx: Context,
    config: ReturnType<typeof getConfig>,
    registry: SessionStateRegistry,
    logger: Logger,
    prompts: PromptStore,
): Promise<void> {
    if (config.compress.permission === "deny") return

    const factoryCtx = {
        client: ctx,
        registry,
        logger,
        config,
        prompts,
        assertPermission: async (sessionID: string) => {
            await ctx.permission.assert({
                sessionID,
                action: "acp_compress",
                resources: ["*"],
                save: ["*"],
            })
        },
    }

    await ctx.tool.transform((editor) => {
        editor.add(createSearchContextToolV2(factoryCtx))
        editor.add(createAcpStatusToolV2(factoryCtx))
        editor.add(createCompressRangeTool(factoryCtx))
        editor.add(createDecompressTool(factoryCtx))
        editor.add(createAcpContextRecapToolV2(factoryCtx))
    })
}

export const AcpV2Plugin = Plugin.define({
    id: "opencode-acp",

    async setup(ctx) {
        const config = getConfig({
            directory: ctx.location.directory,
            notify: (title, message) => notifySession(ctx, title, message),
        })
        if (!config.enabled) return

        const logger = new Logger(config.debug, config.debug ? "debug" : config.logLevel)
        configureNativeStateStorage({
            get: (key) => ctx.storage.get(key),
            set: (key, value) => ctx.storage.set(key, value as never),
            scan: (options) => ctx.storage.scan(options),
        })
        const registry = new SessionStateRegistry(logger, ctx.location.directory)
        const prompts = new PromptStore(
            logger,
            ctx.location.directory,
            config.experimental.customPrompts,
            config.compress.candidates === true,
        )
        startAutoUpdate(
            {
                notify: (title, message) => notifySession(ctx, title, message),
            },
            config.autoUpdate,
            logger,
        )
        const hostPermissions: HostPermissionSnapshot = {
            global: undefined,
            agents: {},
        }

        void registry.hydrateModelLimitsFromClient(ctx)

        const commandHandler = createCommandExecuteHandler(
            ctx,
            registry,
            logger,
            config,
            ctx.location.directory,
            hostPermissions,
        )
        if (config.commands.enabled && config.compress.permission !== "deny") {
            await ctx.command.transform((editor) => {
                editor.add({
                    name: "acp",
                    description: "Show ACP context compression commands",
                    execute: async ({ sessionID, prompt }) => {
                        try {
                            await commandHandler(
                                {
                                    command: "acp",
                                    sessionID,
                                    arguments: prompt.text.trim(),
                                },
                                { parts: [] },
                            )
                        } catch (error) {
                            if (
                                error instanceof Error &&
                                error.message === "__ACP_CONTEXT_HANDLED__"
                            ) {
                                return
                            }
                            throw error
                        }
                    },
                })
            })
        }

        await registerTools(ctx, config, registry, logger, prompts)

        const transformMessages = createChatMessageTransformHandler(
            ctx,
            registry,
            logger,
            config,
            prompts,
            hostPermissions,
        )
        const transformSystem = createSystemPromptHandler(registry, logger, config, prompts)

        await ctx.session.hook("context", async (event) => {
            await diagnoseContext(logger, event.sessionID, async (diagnostic) => {
                const timeline = diagnostic?.timeline("context", "fetchSessionMessages")
                const checkpoint = (stage: string) => timeline?.next(stage)
                const messages = await fetchV2SessionMessages(ctx, event.sessionID)
                checkpoint("prepareMessages")
                if (diagnostic) diagnostic.counts.inputMessages = messages.length
                if (messages.length === 0) {
                    diagnostic?.skip("empty_history")
                    return
                }

                const lastUser = [...messages]
                    .reverse()
                    .find((message) => message.info.role === "user")
                if (lastUser?.info.role === "user") {
                    lastUser.info.agent = event.agent
                    lastUser.info.model = {
                        providerID: event.model.providerID,
                        modelID: event.model.id,
                    }
                    lastUser.info.providerID = event.model.providerID
                    lastUser.info.modelID = event.model.id
                }

                const output = { messages }
                checkpoint("transformMessages")
                await transformMessages({}, output)
                if (diagnostic) diagnostic.counts.outputMessages = output.messages.length
                checkpoint("convertRequestMessages")
                event.messages = toV2RequestMessages(output.messages) as typeof event.messages
                checkpoint("transformSystem")

                const systemOutput = {
                    system: event.system.map((part) => part.text),
                }
                await transformSystem(
                    {
                        sessionID: event.sessionID,
                        model: asV2Model(event.model),
                    },
                    systemOutput,
                )
                event.system = systemOutput.system.map((text) => ({ type: "text", text }))
            })
        })

        const abort = new AbortController()
        const eventHandler = createEventHandler(registry, logger)
        const toolNames = new Map<string, string>()
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
                if (event.type === "session.idle" || event.type === "session.deleted") {
                    await eventHandler({
                        event: {
                            type: event.type,
                            properties: { sessionID: event.data.sessionID },
                        },
                    })
                    continue
                }

                if (
                    event.type !== "session.tool.called" &&
                    event.type !== "session.tool.success" &&
                    event.type !== "session.tool.failed"
                ) {
                    continue
                }

                const name =
                    toolNames.get(event.data.id) ??
                    (await findV2ToolName(ctx, event.data.sessionID, event.data.id))
                if (name !== "acp_compress") continue
                toolNames.set(event.data.id, name)

                const status =
                    event.type === "session.tool.called"
                        ? "pending"
                        : event.type === "session.tool.success"
                          ? "completed"
                          : "error"
                await eventHandler({
                    event: {
                        type: "message.part.updated",
                        time: event.created,
                        properties: {
                            part: {
                                type: "tool",
                                tool: name,
                                callID: event.data.id,
                                messageID: event.data.assistantMessageID,
                                state: { status, time: { completed: event.created } },
                            },
                        },
                    },
                })
            }
        })()

        return () => abort.abort()
    },
})
