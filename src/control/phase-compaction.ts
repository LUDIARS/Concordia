/** @implements spec/feature/phase-compaction.md */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { parseContractMetadata } from "../contract/schema.js";
import { createChildLogger } from "../shared/logger.js";
import type { SessionRow } from "../shared/types.js";

const log = createChildLogger("phase-compaction");

export type PhaseTrigger = "taskflow:plan-approved" | "taskflow:next-task" | "taskflow:residual-sweep";

type PhaseSessions = Pick<SessionsRepo, "findSession" | "appendEvent">;

export interface PhaseCompactionHandle {
  stop(): void;
  runOnce(id: string, trigger: PhaseTrigger): Promise<void>;
}

export function buildPhaseContext(
  session: SessionRow | null,
  trigger: PhaseTrigger,
): string {
  if (!session) return "";
  const contract = parseContractMetadata(session.metadata);
  let metadata: Record<string, unknown> = {};
  try { metadata = session.metadata ? JSON.parse(session.metadata) as Record<string, unknown> : {}; } catch { /* invalid legacy metadata is omitted */ }
  const phaseReferences = {
    plan_version: metadata.plan_version ?? null,
    plan_md_ref: metadata.plan_md_ref ?? null,
    discord_plan_message_id: metadata.discord_plan_message_id ?? null,
    discord_question_message_id: metadata.discord_question_message_id ?? null,
  };
  return [
    `# Phase boundary handoff (${trigger})`,
    "## Session contract",
    JSON.stringify(contract, null, 2),
    "## Current task",
    session.current_task ?? "Not set",
    "## Durable references",
    JSON.stringify(phaseReferences, null, 2),
    "Continue from these durable references; do not rely on discarded conversational context.",
  ].join("\n\n");
}

export function startPhaseCompaction(input: {
  sessions: PhaseSessions;
  compact: (id: string) => Promise<{ ok: boolean; error?: string }>;
  estimateContextPct: (session: SessionRow) => Promise<number | null>;
  threshold?: number;
}): PhaseCompactionHandle {
  const threshold = input.threshold ?? Number(process.env.CONCORDIA_PHASE_COMPACT_PCT ?? 35) / 100;
  const run = async (id: string, trigger: PhaseTrigger) => {
    const session = input.sessions.findSession(id);
    if (!session || session.status !== "active") return;
    const contextPct = await input.estimateContextPct(session);
    const context = buildPhaseContext(session, trigger);
    if (contextPct !== null && contextPct >= threshold) {
      const result = await input.compact(id);
      if (!result.ok) throw new Error(result.error ?? "compact_failed");
      return;
    }
    const ts = Math.floor(Date.now() / 1000);
    input.sessions.appendEvent({ session_id: id, ts, kind: "inject", payload: { text: context, source: `phase-compaction:${trigger}` } });
    eventBus.emit({ type: "session.inject", target_session_id: id, text: context, source: `phase-compaction:${trigger}`, ts });
  };
  const stop = eventBus.subscribe((event) => {
    let id: string | undefined;
    let trigger: PhaseTrigger | undefined;
    if (event.type === "session.event" && event.kind === "taskflow:plan-approved") {
      id = event.session_id;
      trigger = "taskflow:plan-approved";
    } else if (event.type === "taskflow.continue_requested") {
      id = event.target_session_id;
      trigger = "taskflow:next-task";
    } else if (event.type === "taskflow.residual_checked") {
      id = event.session_id;
      trigger = "taskflow:residual-sweep";
    }
    if (id && trigger) {
      void run(id, trigger).catch((error: unknown) => log.warn({ error, session_id: id, trigger }, "phase boundary failed"));
    }
  });
  return { stop, runOnce: run };
}
