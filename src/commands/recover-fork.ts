import { isDeepStrictEqual } from "node:util"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { type SessionStateRegistry } from "../state/state"
import {
    resolveStorageDir,
    rollbackForkRecovery,
    withSessionRecovery,
    snapshotSessionState,
    sameRecoveryState,
    readRecoveryState,
} from "../state/persistence"
import { applyForkRecovery, prepareForkRecovery } from "../state/fork-recovery"
import { fetchSessionMessages } from "../compress/search"
import { sendIgnoredMessage } from "../ui/notification"

export async function handleRecoverForkCommand(
    ctx: {
        client: any
        registry: SessionStateRegistry
        config: PluginConfig
        logger: Logger
        sessionId: string
        workingDirectory: string
    },
    args: string,
): Promise<void> {
    let report: string
    try {
        const tokens = args.trim().split(/\s+/).filter(Boolean)
        const rollback = tokens[0] === "--rollback" && tokens.length === 2 ? tokens[1] : undefined
        const apply = tokens.length === 1 && tokens[0] === "--apply"
        if (tokens.length > 0 && !rollback && !apply) {
            throw new Error("Usage: /acp recover-fork [--apply | --rollback <backup-id>]")
        }
        const live = ctx.registry.get(ctx.sessionId)
        const baseline = live ? structuredClone(live) : undefined
        const unchanged = () => {
            const current = ctx.registry.all().find((state) => state.sessionId === ctx.sessionId)
            return current === live && (!live || isDeepStrictEqual(live, baseline))
        }
        const storageDir =
            live?.storageDir ??
            (ctx.config.storagePath
                ? resolveStorageDir(ctx.config.storagePath, ctx.workingDirectory)
                : undefined)
        if (rollback) {
            await withSessionRecovery(ctx.sessionId, storageDir, async () => {
                if (!unchanged()) throw new Error("Session changed; retry while idle.")
                const persisted = await readRecoveryState(ctx.sessionId, storageDir)
                if (
                    live &&
                    !sameRecoveryState(
                        persisted,
                        JSON.stringify(
                            snapshotSessionState(live, JSON.parse(persisted).sessionName),
                        ),
                    )
                ) {
                    throw new Error(
                        "Live state differs from persisted state; rollback refused to preserve unsaved work.",
                    )
                }
                await rollbackForkRecovery(ctx.sessionId, storageDir, rollback, unchanged, () =>
                    ctx.registry.invalidate(ctx.sessionId),
                )
            })
            report =
                "Rollback completed. The original persisted state will load on the next request."
        } else {
            const messages = await fetchSessionMessages(ctx.client, ctx.sessionId)
            const plan = await prepareForkRecovery(
                ctx.client,
                ctx.sessionId,
                storageDir,
                messages,
                ctx.logger,
                live,
            )
            if (!unchanged()) throw new Error("Session changed; retry while idle.")
            const details = `Source: ${plan.sourceId}\nBlocks: ${plan.restored} (${plan.active} active)`
            if (!apply) {
                report = `Preview only — no ACP state or backup written.\n${details}\nRun /acp recover-fork --apply to back up and restore this session.\nUse one OpenCode instance and an idle session; shared concurrent writers are not supported.`
            } else {
                const backup = await applyForkRecovery(
                    ctx.sessionId,
                    storageDir,
                    plan,
                    unchanged,
                    () => ctx.registry.invalidate(ctx.sessionId),
                )
                report = `Recovery applied.\n${details}\nBackup: ${backup.path}\nRollback: /acp recover-fork --rollback ${backup.id}\nRollback is refused if persisted state has changed since recovery.`
            }
        }
    } catch (error) {
        report = `Recovery refused or failed: ${error instanceof Error ? error.message : String(error)}`
    }
    await sendIgnoredMessage(
        ctx.client,
        ctx.sessionId,
        `[ACP Fork Recovery]\n${report}`,
        {},
        ctx.logger,
    )
}
