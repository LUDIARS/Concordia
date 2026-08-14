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

/** 索引に載せる回答済み設問 (契約カード回答含む) の参照。 */
export interface AnsweredQuestionRef {
  question: string;
  answer_text: string | null;
  discord_message_id: string | null;
}

/** 索引の組み立てに使う正本参照群。 未注入の項目は索引から省く (探索はしない)。 */
export interface PhaseContextSources {
  answeredQuestions?: (sessionId: string) => AnsweredQuestionRef[];
}

const ANSWERED_QUESTION_TEXT_LIMIT = 200;
const ANSWERED_ANSWER_TEXT_LIMIT = 300;

function oneLine(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function buildPhaseContext(
  session: SessionRow | null,
  trigger: PhaseTrigger,
  sources?: PhaseContextSources,
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
  const answered = sources?.answeredQuestions?.(session.id) ?? [];
  const answeredSection = answered.length === 0
    ? "None"
    : answered
        .map((entry) => {
          const link = entry.discord_message_id ? ` [message_id=${entry.discord_message_id}]` : "";
          return `- Q: ${oneLine(entry.question, ANSWERED_QUESTION_TEXT_LIMIT)} / A: ${oneLine(entry.answer_text ?? "(no answer text)", ANSWERED_ANSWER_TEXT_LIMIT)}${link}`;
        })
        .join("\n");
  const lastHandoff = typeof metadata.last_handoff === "string" && metadata.last_handoff.trim().length > 0
    ? metadata.last_handoff
    : "None";
  return [
    `# Phase boundary handoff (${trigger})`,
    "## Session contract",
    JSON.stringify(contract, null, 2),
    "## Current task",
    session.current_task ?? "Not set",
    "## Durable references",
    JSON.stringify(phaseReferences, null, 2),
    "## Answered questions",
    answeredSection,
    "## Latest handoff",
    lastHandoff,
    "Continue from these durable references; do not rely on discarded conversational context.",
  ].join("\n\n");
}

export function startPhaseCompaction(input: {
  sessions: PhaseSessions;
  compact: (id: string) => Promise<{ ok: boolean; error?: string }>;
  estimateContextPct: (session: SessionRow) => Promise<number | null>;
  threshold?: number;
  /** 索引の正本参照 (回答済み設問など)。 未注入なら索引は metadata のみで組む。 */
  contextSources?: PhaseContextSources;
}): PhaseCompactionHandle {
  const threshold = input.threshold ?? Number(process.env.CONCORDIA_PHASE_COMPACT_PCT ?? 35) / 100;
  const run = async (id: string, trigger: PhaseTrigger) => {
    let session = input.sessions.findSession(id);
    if (!session || session.status !== "active") return;
    const contextPct = await input.estimateContextPct(session);
    if (contextPct !== null && contextPct >= threshold) {
      const result = await input.compact(id);
      if (!result.ok) throw new Error(result.error ?? "compact_failed");
      // compact は /clear 後に session handoff を再投入するが、機械組み立てした
      // 契約・カード索引までは扱わない。metadata も compact 中に更新されるため、
      // 最新行から文脈を組み直して必ず続けて投入する。
      session = input.sessions.findSession(id);
      if (!session || session.status !== "active") return;
    }
    let context: string;
    try {
      context = buildPhaseContext(session, trigger, input.contextSources);
    } catch (error) {
      // 回答索引は補助層。取得失敗で契約・タスクの再投入まで失わせない。
      log.warn({ error, session_id: id, trigger }, "phase context source failed; using metadata only");
      context = buildPhaseContext(session, trigger);
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
