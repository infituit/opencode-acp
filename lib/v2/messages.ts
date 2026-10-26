import type { WithParts } from "../state"

type V2Message = {
    id?: string
    type?: string
    sessionID?: string
    time?: { created?: number }
    text?: string
    agent?: string
    model?: { providerID?: string; id?: string }
    content?: unknown[]
    files?: Array<{
        data?: string
        mime?: string
        source?: { type?: string; uri?: string }
    }>
}

type V2ToolPart = {
    type?: string
    id?: string
    name?: string
    input?: unknown
    result?: unknown
    state?: {
        status?: string
        input?: unknown
        content?: unknown
        error?: unknown
    }
}

function createdAt(message: V2Message): number {
    return typeof message.time?.created === "number" ? message.time.created : Date.now()
}

function textFromContent(value: unknown): string {
    if (typeof value === "string") return value
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === "string") return item
                if (item && typeof item === "object" && "text" in item) {
                    const text = (item as { text?: unknown }).text
                    return typeof text === "string" ? text : ""
                }
                return JSON.stringify(item)
            })
            .filter(Boolean)
            .join("\n")
    }
    if (value === undefined || value === null) return ""
    return typeof value === "object" ? JSON.stringify(value) : String(value)
}

function convertToolPart(part: V2ToolPart): Record<string, unknown> {
    const state = part.state
    const status = state?.status ?? (part.result !== undefined ? "completed" : "pending")
    const output = state?.content ?? state?.error ?? part.result

    return {
        type: "tool",
        callID: part.id ?? "v2-tool-call",
        tool: part.name ?? "tool",
        state: {
            status,
            input: state?.input ?? part.input,
            output: textFromContent(output),
        },
    }
}

function convertParts(message: V2Message): unknown[] {
    if (message.type === "user") {
        const parts: unknown[] = []
        if (typeof message.text === "string") {
            parts.push({ type: "text", text: message.text })
        }
        for (const file of message.files ?? []) {
            if (typeof file.data !== "string" || typeof file.mime !== "string") continue
            const url =
                file.source?.type === "uri" && file.source.uri
                    ? file.source.uri
                    : `data:${file.mime};base64,${file.data}`
            parts.push({ type: "file", url, mime: file.mime })
        }
        return parts
    }

    const parts: unknown[] = []
    for (const item of message.content ?? []) {
        if (!item || typeof item !== "object") continue
        const part = item as V2ToolPart & { text?: unknown }
        if (part.type === "text") {
            parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "" })
        } else if (part.type === "reasoning") {
            parts.push({ type: "reasoning", text: typeof part.text === "string" ? part.text : "" })
        } else if (
            part.type === "tool" ||
            part.type === "tool-call" ||
            part.type === "tool-result"
        ) {
            parts.push(convertToolPart(part))
        }
    }
    return parts
}

/** Convert V2 durable session messages into ACP's domain message view. */
export function fromV2SessionMessages(input: unknown, sessionID: string): WithParts[] {
    if (!Array.isArray(input)) return []

    const result: WithParts[] = []
    for (const value of input) {
        if (!value || typeof value !== "object") continue
        const message = value as V2Message
        if (message.type !== "user" && message.type !== "assistant") continue
        if (typeof message.id !== "string") continue

        const role = message.type
        const info = {
            id: message.id,
            sessionID,
            role,
            time: { created: createdAt(message) },
            agent: message.agent ?? "code",
            model: {
                providerID: message.model?.providerID ?? "",
                modelID: message.model?.id ?? "",
            },
            parentID: "",
            modelID: message.model?.id ?? "",
            providerID: message.model?.providerID ?? "",
            mode: "code",
            path: { cwd: "", root: "" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }

        result.push({
            info: info as WithParts["info"],
            parts: convertParts(message) as WithParts["parts"],
        })
    }
    return result
}

export async function fetchV2SessionMessages(
    client: unknown,
    sessionID: string,
): Promise<WithParts[]> {
    const runtime = client as {
        session?: { context?: (input: { sessionID: string }) => Promise<unknown> }
    }
    if (typeof runtime.session?.context !== "function") {
        return []
    }
    return fromV2SessionMessages(await runtime.session.context({ sessionID }), sessionID)
}

function toolIdentity(part: Record<string, unknown>) {
    return {
        id: typeof part.callID === "string" ? part.callID : "v2-tool-call",
        name: typeof part.tool === "string" ? part.tool : "tool",
    }
}

function toV2ToolCall(part: Record<string, unknown>): Record<string, unknown> {
    const state = (part.state ?? {}) as Record<string, unknown>
    return {
        type: "tool-call",
        ...toolIdentity(part),
        input: state.input ?? {},
    }
}

function toV2ToolResult(part: Record<string, unknown>): Record<string, unknown> {
    const state = (part.state ?? {}) as Record<string, unknown>
    return {
        type: "tool-result",
        ...toolIdentity(part),
        result: {
            type: state.status === "error" ? "error" : "text",
            value: state.output ?? "",
        },
    }
}

function toV2Content(part: Record<string, unknown>): Record<string, unknown> | undefined {
    if (part.type === "text") {
        return { type: "text", text: typeof part.text === "string" ? part.text : "" }
    }
    if (part.type === "reasoning") {
        return { type: "reasoning", text: typeof part.text === "string" ? part.text : "" }
    }
    if (part.type === "tool") {
        const state = (part.state ?? {}) as Record<string, unknown>
        return state.status === "completed" || state.status === "error"
            ? toV2ToolResult(part)
            : toV2ToolCall(part)
    }
    return undefined
}

/** Convert the internal post-transform view back to V2 model messages. */
export function toV2RequestMessages(messages: WithParts[]): unknown[] {
    const result: unknown[] = []

    for (const message of messages) {
        const content: Record<string, unknown>[] = []
        const toolResults: Record<string, unknown>[] = []
        for (const value of message.parts) {
            const part = value as unknown as Record<string, unknown>
            if (message.info.role === "assistant" && part.type === "tool") {
                content.push(toV2ToolCall(part))
                const state = (part.state ?? {}) as Record<string, unknown>
                if (state.status === "completed" || state.status === "error") {
                    toolResults.push(toV2ToolResult(part))
                }
                continue
            }
            const converted = toV2Content(part)
            if (converted !== undefined) content.push(converted)
        }

        // OpenResponses treats tool output as a separate `tool` message. A
        // durable OpenCode assistant message stores a completed tool part next
        // to the assistant's text/tool-call parts, so split it before handing
        // the request to the model adapter. Keeping tool-result inside an
        // assistant message is rejected by OpenAI Responses-compatible models.
        if (message.info.role === "assistant") {
            const assistantContent = content.filter((part) => part.type !== "tool-result")
            if (assistantContent.length > 0) {
                result.push({ role: "assistant", content: assistantContent })
            }
            for (const part of toolResults) {
                result.push({ role: "tool", content: [part] })
            }
            continue
        }

        if (content.length > 0) {
            result.push({ role: message.info.role, content })
        }
    }

    return result
}
