import type { WithParts } from "../state"
import { COMPACTED_TOOL_OUTPUT_PLACEHOLDER } from "../context-usage"

// Assets belong to the host SDK instance (including private fields). Keep the
// native part out of ACP's serializable file view and never clone its asset.
const requestMedia = new WeakMap<object, Record<string, unknown>>()

function projectRequestPart(value: unknown): unknown {
    if (!value || typeof value !== "object") return value
    const part = value as Record<string, any>
    if (part.type !== "media") return structuredClone(part)
    const source = part.media?.source
    const mime = part.media?.mediaType
    const url =
        source?.type === "base64"
            ? `data:${mime};base64,${source.data}`
            : source?.type === "bytes" && source.data instanceof Uint8Array
              ? `data:${mime};base64,${Buffer.from(source.data).toString("base64")}`
              : source?.type === "url"
                ? source.url
                : undefined
    const file = { type: "file", url, mime, filename: part.filename }
    requestMedia.set(file, part)
    return file
}

type V2Message = {
    id?: string
    type?: string
    sessionID?: string
    time?: { created?: number }
    text?: string
    description?: string
    metadata?: Record<string, unknown>
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
        metadata?: Record<string, unknown>
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
                // File payloads must not be counted, truncated or sent as text.
                if (item && typeof item === "object" && item.type === "file") return ""
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
            ...(Array.isArray(output) && output.some((item) => item?.type === "file")
                ? { content: structuredClone(output) }
                : {}),
            ...(state?.metadata?.acpHostInputRefs === true
                ? { metadata: { acpHostInputRefs: true } }
                : {}),
        },
    }
}

function convertParts(message: V2Message): unknown[] {
    if (message.type === "user" || message.type === "synthetic") {
        const parts: unknown[] = []
        if (typeof message.text === "string") {
            parts.push({ type: "text", text: message.text })
        }
        for (const file of message.files ?? []) {
            if (typeof file.data !== "string" || typeof file.mime !== "string") continue
            const url = `data:${file.mime};base64,${file.data}`
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

type V2RequestInput = {
    id?: string
    role?: string
    content?: unknown
    metadata?: Record<string, unknown>
}

/** ACP notifications are UI output, not fresh model input. */
function isAcpNotification(message: V2Message): boolean {
    return (
        message.metadata?.source === "opencode-acp" ||
        (message.metadata?.source === undefined &&
            (message.description === "ACP" ||
                message.description === "ACP update ready" ||
                message.description?.startsWith("ACP:") === true))
    )
}

/** Convert durable messages, restricting host deliveries to the active request when supplied. */
export function fromV2SessionMessages(
    input: unknown,
    sessionID: string,
    requestMessages?: readonly unknown[],
): WithParts[] {
    if (!Array.isArray(input)) return []

    const requestInputs = new Map<string, V2RequestInput>()
    for (const value of requestMessages ?? []) {
        if (!value || typeof value !== "object") continue
        const message = value as V2RequestInput
        if (message.role === "user" && typeof message.id === "string") {
            requestInputs.set(message.id, message)
        }
    }

    const result: WithParts[] = []
    for (const value of input) {
        if (!value || typeof value !== "object") continue
        const message = value as V2Message
        const hostInput = message.type === "synthetic"
        if (!hostInput && message.type !== "user" && message.type !== "assistant") continue
        if (typeof message.id !== "string") continue
        const requestInput = requestInputs.get(message.id)
        if (hostInput && (isAcpNotification(message) || (requestMessages && !requestInput)))
            continue

        const role = hostInput ? "user" : message.type
        const info = {
            id: message.id,
            sessionID,
            role,
            ...(hostInput
                ? { hostInput: { metadata: requestInput?.metadata ?? message.metadata } }
                : {}),
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

        // Use the host's complete user projection: attachment text, deduplication
        // and native media instances have already been resolved there.
        const projectedContent = requestInput?.content
        const parts =
            typeof projectedContent === "string"
                ? [{ type: "text", text: projectedContent }]
                : Array.isArray(projectedContent)
                  ? projectedContent.map(projectRequestPart)
                  : convertParts(message)
        result.push({
            info: info as WithParts["info"],
            parts: parts as WithParts["parts"],
        })
    }
    return result
}

export async function fetchV2SessionMessages(
    client: unknown,
    sessionID: string,
    requestMessages?: readonly unknown[],
): Promise<WithParts[]> {
    const runtime = client as {
        session?: { context?: (input: { sessionID: string }) => Promise<unknown> }
    }
    if (typeof runtime.session?.context !== "function") {
        return []
    }
    return fromV2SessionMessages(
        await runtime.session.context({ sessionID }),
        sessionID,
        requestMessages,
    )
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
    const output = state.output ?? ""
    let result: Record<string, unknown> = {
        type: state.status === "error" ? "error" : "text",
        value: output,
    }
    if (
        state.status === "completed" &&
        Array.isArray(state.content) &&
        !(state.time as { compacted?: unknown } | undefined)?.compacted &&
        !(typeof output === "string" && output.startsWith(COMPACTED_TOOL_OUTPUT_PLACEHOLDER))
    ) {
        // ACP owns the text view; never restore text that filters or budget
        // enforcement removed. Files remain structured for provider lowering.
        const originalText = textFromContent(state.content)
        const content =
            output === originalText
                ? state.content
                : typeof output === "string" && output.startsWith(originalText)
                  ? [...state.content, { type: "text", text: output.slice(originalText.length) }]
                  : [
                        { type: "text", text: output },
                        ...state.content.filter((item) => item?.type === "file"),
                    ]
        result = { type: "content", value: content }
    }
    return { type: "tool-result", ...toolIdentity(part), result }
}

function toV2Content(part: Record<string, unknown>): Record<string, unknown> | undefined {
    if (part.type === "file") return requestMedia.get(part)
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
            result.push({
                role: message.info.role,
                content,
                ...(message.info.role === "user" && message.info.hostInput
                    ? { id: message.info.id, metadata: message.info.hostInput.metadata }
                    : {}),
            })
        }
    }

    return result
}
