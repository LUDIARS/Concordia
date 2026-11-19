/** @implements spec/feature/project-harness-policy.md */
import { resolve } from "node:path";
import { evaluateAction, type GateVerdict } from "./session-gate.js";
import { DEFAULT_PREDICATES, withMainPushAllowlist, type HarnessAction } from "./predicates.js";
import { makeStrongModelImplPredicate } from "./strong-model-gate.js";
import { projectPredicates, type ProjectHarnessPolicy } from "./project-policy.js";

export interface LocalPolicySnapshot {
  version: 1;
  capturedAt: number;
  sessionId: string;
  repo: string;
  branch: string;
  context: Partial<HarnessAction> & { model?: string };
  policy: ProjectHarnessPolicy;
  mainPushAllowlist: string[];
  strongImplModels: string[];
  editedRepos: string[];
  editedFiles: string[];
  taskBranchLiveRequired?: boolean;
}

export type SnapshotUnusableReason = "expired" | "session_mismatch" | "branch_mismatch" | "corrupt";

/**
 * Why a cached snapshot cannot be used, or null when it can. `usableSnapshot` is defined from
 * this so the diagnosis and the permission decision can never disagree.
 * Repo mismatch is reported as corrupt: the cache key already hashes the repo root, so a
 * different `repo` means the file does not belong to its own key.
 */
export function snapshotUnusableReason(value: unknown, action: HarnessAction, sessionId: string, now: number): SnapshotUnusableReason | null {
  if (!value || typeof value !== "object") return "corrupt";
  const snapshot = value as LocalPolicySnapshot;
  const wellFormed = snapshot.version === 1 && Number.isFinite(snapshot.capturedAt)
    && typeof snapshot.sessionId === "string" && typeof snapshot.repo === "string" && typeof snapshot.branch === "string"
    && !!snapshot.context && typeof snapshot.context === "object"
    && typeof snapshot.policy?.ddd === "boolean" && typeof snapshot.policy?.contract === "boolean"
    && [snapshot.mainPushAllowlist, snapshot.strongImplModels, snapshot.editedRepos, snapshot.editedFiles]
      .every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
  if (!wellFormed || !action.cwd || snapshot.repo !== action.cwd) return "corrupt";
  if (!sessionId || snapshot.sessionId !== sessionId) return "session_mismatch";
  if (snapshot.branch !== action.branch) return "branch_mismatch";
  if (now < snapshot.capturedAt || now - snapshot.capturedAt > 15 * 60_000) return "expired";
  return null;
}

export function usableSnapshot(value: unknown, action: HarnessAction, sessionId: string, now: number): value is LocalPolicySnapshot {
  return snapshotUnusableReason(value, action, sessionId, now) === null;
}

export function evaluateCachedAction(action: HarnessAction, snapshot: LocalPolicySnapshot): GateVerdict {
  if (snapshot.taskBranchLiveRequired && (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(action.tool) || action.command)) {
    return { decision: "deny", blocked: true, reason: "作業境界はCcへ再接続して確認してください。古いキャッシュでPR後の作業を許可しません。",
      hits: [{ rule: "task-branch-live-required", decision: "deny", reason: "Current task/PR boundary unavailable" }] };
  }
  return evaluateAction({
    ...snapshot.context, ...action,
    sessionModel: snapshot.context.model,
    projectRegistered: snapshot.policy.registered === true,
    editedRepos: [...new Set([...snapshot.editedRepos, action.cwd ?? ""])],
    editedFiles: [...new Set([...snapshot.editedFiles, ...(action.filePath ? [action.filePath] : [])])],
  }, [
    ...projectPredicates(withMainPushAllowlist(snapshot.mainPushAllowlist, DEFAULT_PREDICATES), snapshot.policy),
    makeStrongModelImplPredicate(snapshot.strongImplModels),
  ]);
}

/** Offline recovery is an explicit installation policy, not an inferred blanket exemption. */
export function recoveryAllowed(action: HarnessAction, recoveryRoots: readonly string[], commands: readonly string[]): boolean {
  if (!action.cwd || !recoveryRoots.some((root) => resolve(root) === resolve(action.cwd!))) return false;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(action.tool)) {
    if (!action.filePath) return false;
    const root = resolve(action.cwd);
    const path = resolve(action.cwd, action.filePath);
    return path.startsWith(root + (root.includes("\\") ? "\\" : "/"));
  }
  return action.tool === "Bash" && !!action.command && commands.includes(action.command.trim());
}
