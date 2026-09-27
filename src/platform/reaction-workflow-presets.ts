import type { CustomSkillWorkflowEntry, CustomWorkflowEntry } from "./reaction-workflow-plan.js";
import { normalizeWorkflowEmoji } from "./reaction-workflow-plan.js";

/** Initial declarative examples; installing them does not execute a skill. */
export const RWF_PRESETS: readonly CustomSkillWorkflowEntry[] = [
  { kind: "skill", emoji: "🧠", skill: "context-report", mode: "inject", cwd: "repo", action: "context", label: "現在地の確認" },
  { kind: "skill", emoji: "🙏", skill: "remaining-enumerate", mode: "inject", cwd: "repo", action: "enumerate-remaining", label: "残作業の整理" },
  { kind: "skill", emoji: "👋", skill: "handoff", mode: "inject", cwd: "repo", action: "handoff-document", label: "引き継ぎ資料" },
];

/** @implements CC-RWF-DATA-01 — existing local choices always win. */
export function addMissingPresets(
  existing: readonly CustomWorkflowEntry[],
  availableSkills: ReadonlySet<string>,
): CustomWorkflowEntry[] {
  const occupied = new Set(existing.map(entry => normalizeWorkflowEmoji(entry.emoji)));
  return [...existing, ...RWF_PRESETS.filter(entry =>
    availableSkills.has(entry.skill) && !occupied.has(normalizeWorkflowEmoji(entry.emoji)))];
}
