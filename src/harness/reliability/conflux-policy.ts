// @spec Cf の作業契約（2026-09-18）
import type { PredicateHit } from "../predicates.js";

export interface ConfluxSelection {
  projectCode: string; tide: string; variant: string; baseBranch: string; workBranch: string;
}
const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function parseConfluxSelection(value: unknown): ConfluxSelection | null {
  if (!value || typeof value !== "object") return null;
  const s = value as ConfluxSelection;
  if (![s.projectCode, s.tide, s.variant].every(v => typeof v === "string" && segment.test(v))) return null;
  const base = "evolution/" + s.tide + "/" + s.variant;
  if (s.baseBranch !== base && s.baseBranch !== base + "/main") return null;
  const prefix = "feature/" + s.tide + "/" + s.variant + "/";
  if (typeof s.workBranch !== "string" || !s.workBranch.startsWith(prefix) || !segment.test(s.workBranch.slice(prefix.length))) return null;
  return { projectCode: s.projectCode, tide: s.tide, variant: s.variant, baseBranch: s.baseBranch, workBranch: s.workBranch };
}
export function confluxDenied(reason: string): PredicateHit {
  return { rule: "conflux-flow-isolation", decision: "deny", reason };
}
export function switchObstacle(input: { dedicated: boolean; peers: boolean; dirty: boolean }): string | null {
  if (!input.dedicated) return "本体checkoutは自動切替しません。専用worktreeを登録してください。";
  if (input.peers) return "他セッションが使用しています。別worktreeへ分離してください。";
  if (input.dirty) return "未コミット変更を保持しました。整理するまで潮流を切り替えません。";
  return null;
}
