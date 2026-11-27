import type { Logger } from "../logger"

/**
 * Legacy command feedback transport. This is persistent V2 synthetic input,
 * not an ignored message or a toast. Background notices must not use it.
 * The explicit /acp command delivery contract is unchanged in this round.
 */
export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    try {
        await client.session.synthetic({
            sessionID,
            text,
            description: "ACP",
            metadata: { source: "opencode-acp" },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
