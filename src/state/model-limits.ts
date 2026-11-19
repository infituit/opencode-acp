import type { Logger } from "../logger"

/**
 * [FIX #312] Catalog of per-model context limits, keyed `${providerID}/${modelID}`.
 *
 * The V2 context hook transforms messages before the system prompt. This
 * catalog lets the messages handler reconcile state.modelContextLimit against
 * the model named on the request's user message before percentage thresholds
 * (emergencyThresholdPercent, min/maxContextLimit "%", GC tiers) are computed.
 *
 * Entries are seeded at plugin init from the V2 model catalog and resolved
 * again on a request-time miss through the registry's existing lazy hydration.
 *
 * Standalone factory (not embedded in SessionStateRegistry) so the test
 * registry stub can compose the SAME implementation instead of hand-rolling
 * a drift-prone copy.
 */
export interface ModelLimitCatalog {
    record(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void
    resolve(providerId: string | undefined, modelId: string | undefined): number | undefined
    hydrateFromClient(client: unknown): Promise<number>
}

export function createModelLimitCatalog(logger?: Logger): ModelLimitCatalog {
    const modelLimits = new Map<string, number>()
    return {
        record(providerId, modelId, limit) {
            if (!providerId || !modelId || typeof limit !== "number" || limit <= 0) return
            modelLimits.set(`${providerId}/${modelId}`, limit)
        },
        resolve(providerId, modelId) {
            if (!providerId || !modelId) return undefined
            return modelLimits.get(`${providerId}/${modelId}`)
        },
        /**
         * Best-effort load from the V2 model catalog. Never throws;
         * returns the number of model-limit entries recorded.
         */
        async hydrateFromClient(client: unknown): Promise<number> {
            try {
                const v2Client = client as {
                    model?: { list?: () => Promise<{ data?: unknown }> }
                } | null
                if (typeof v2Client?.model?.list !== "function") {
                    logger?.warn("Model limit catalog load failed", {
                        reason: "api_unavailable",
                        catalogSize: modelLimits.size,
                    })
                    return 0
                }
                const response = await v2Client.model.list()
                if (!Array.isArray(response?.data)) {
                    logger?.warn("Model limit catalog load failed", {
                        reason: "invalid_response",
                        catalogSize: modelLimits.size,
                    })
                    return 0
                }
                let recorded = 0
                for (const value of response.data) {
                    if (!value || typeof value !== "object") continue
                    const model = value as {
                        providerID?: unknown
                        id?: unknown
                        limit?: { context?: unknown }
                    }
                    if (
                        typeof model.providerID !== "string" ||
                        typeof model.id !== "string" ||
                        typeof model.limit?.context !== "number" ||
                        model.limit.context <= 0
                    ) {
                        continue
                    }
                    modelLimits.set(`${model.providerID}/${model.id}`, model.limit.context)
                    recorded++
                }
                logger?.info("Model limit catalog loaded", {
                    reason:
                        response.data.length === 0
                            ? "empty_catalog"
                            : recorded === 0
                              ? "no_valid_limits"
                              : "loaded",
                    entries: response.data.length,
                    recorded,
                    skipped: response.data.length - recorded,
                    catalogSize: modelLimits.size,
                })
                return recorded
            } catch {
                // Do not log response bodies or exception text: providers can embed credentials.
                logger?.warn("Model limit catalog load failed", {
                    reason: "request_failed",
                    catalogSize: modelLimits.size,
                })
                return 0
            }
        },
    }
}
