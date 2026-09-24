import { WORK_PHASE_LABELS, type WorkPhaseView } from "../work/session-work-phase.js";

export type ForumWorkPhase = WorkPhaseView["phase"];
const PHASE_PREFIX = /^\[(設計|確認|実装|調整|未確認)\]\s*/u;

/** Keep the project and phase before the truncatable user-authored summary. */
export function buildForumThreadTitle(
  projectCode: string, summary: string, delegationEmoji?: string | null,
  phase: ForumWorkPhase = "unknown",
): string {
  const body = summary.replace(/\s+/g, " ").trim() || "session";
  const emoji = delegationEmoji?.trim() ? `${delegationEmoji.trim()} ` : "";
  return `${emoji}[${projectCode}] [${WORK_PHASE_LABELS[phase]}] ${body}`.slice(0, 100);
}

/** Only replace the managed phase prefix; a locked/manual summary is untouched. */
export function withForumWorkPhase(title: string, phase: ForumWorkPhase): string {
  const parts = /^(.*?\[[^\]]+\])\s*(.*)$/u.exec(title);
  if (!parts) return title; // Not a managed forum title: never guess its project.
  const summary = parts[2]!.replace(PHASE_PREFIX, "");
  return `${parts[1]} [${WORK_PHASE_LABELS[phase]}] ${summary}`.slice(0, 100);
}

export function forumWorkPhase(title: string): ForumWorkPhase {
  const label = /^.*?\[[^\]]+\]\s*\[([^\]]+)\]/u.exec(title)?.[1];
  return (Object.keys(WORK_PHASE_LABELS) as ForumWorkPhase[])
    .find((phase) => WORK_PHASE_LABELS[phase] === label) ?? "unknown";
}
