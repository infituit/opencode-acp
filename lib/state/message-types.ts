export interface MessageTime {
    created: number
    completed?: number
}

export interface UserMessage {
    id: string
    sessionID: string
    role: "user"
    time: MessageTime
    agent: string
    model: { providerID: string; modelID: string; variant?: string }
    [key: string]: unknown
}

export interface AssistantMessage {
    id: string
    sessionID: string
    role: "assistant"
    time: MessageTime
    parentID: string
    modelID: string
    providerID: string
    mode: string
    agent: string
    path: { cwd: string; root: string }
    cost: number
    tokens: {
        input: number
        output: number
        reasoning: number
        cache: { read: number; write: number }
    }
    summary?: boolean
    [key: string]: unknown
}

export type Message = UserMessage | AssistantMessage

export interface TextPart {
    type: "text"
    text: string
    id?: string
    sessionID?: string
    messageID?: string
    synthetic?: boolean
    [key: string]: unknown
}

export interface ReasoningPart {
    type: "reasoning"
    text: string
    [key: string]: unknown
}

export interface ToolPart {
    type: "tool"
    callID: string
    tool: string
    messageID?: string
    state?: {
        status: string
        input?: unknown
        output?: string
        time?: { start?: number; end?: number; completed?: number }
        [key: string]: unknown
    }
    [key: string]: unknown
}

export interface FilePart {
    type: "file"
    url?: string
    mime?: string
    filename?: string
    [key: string]: unknown
}

export interface GenericPart {
    type: string
    [key: string]: unknown
}

export type Part = any
