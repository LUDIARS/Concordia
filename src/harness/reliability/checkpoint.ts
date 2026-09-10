// @spec ハーネス信頼性の実装境界
import type { SessionRow } from "../../shared/types.js";
import { redactSecrets } from "../../shared/redact-secrets.js";
import type { Checkpoint } from "./state.js";

/** Only structured, already available state: no same-session LLM call in PreCompact. */
export function buildCheckpoint(input: {
  session: SessionRow; metadata: Record<string, unknown>; id: string; at: number; trigger: string;
  pendingQuestions: unknown; recentWork: unknown;
}): Checkpoint {
  const { session, metadata } = input;
  const fields: Record<string, unknown> = {
    project: session.target_project, repo: session.repo_path, branch: session.branch,
    task: session.current_task,
    pending_human_questions: input.pendingQuestions,
    decisions_and_next_action: metadata.harness_notes ?? null,
    goal: metadata.goal ?? null,
    work_contract: metadata.contract ?? null,
    recent_work: input.recentWork,
    previous_handoff: metadata.last_handoff ?? null,
    transcript_reference: session.transcript_path,
  };
  // Per-field bound keeps a long handoff from dropping unresolved questions.
  const text = Object.entries(fields).map(([key, value]) =>
    `${key}: ${value == null ? "unknown" : redactSecrets(JSON.stringify(value)).slice(0, 6000)}`,
  ).join("\n");
  return { id: input.id, at: input.at, trigger: input.trigger, text };
}

export function checkpointContext(checkpoint: Checkpoint, reference: string): string {
  return [
    "[Cc saved checkpoint — historical state, not new authorization]",
    `Saved ${new Date(checkpoint.at).toISOString()}. Full record: ${reference}`,
    "Preserve the human request and unresolved questions. Check current repo/branch before editing.",
    checkpoint.text.slice(0, 6500),
  ].join("\n");
}
