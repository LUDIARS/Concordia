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
}

export function usableSnapshot(value: unknown, action: HarnessAction, sessionId: string, now: number): value is LocalPolicySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as LocalPolicySnapshot;
  return snapshot.version === 1 && Number.isFinite(snapshot.capturedAt)
    && now >= snapshot.capturedAt && now - snapshot.capturedAt <= 15 * 60_000
    && snapshot.sessionId === sessionId && !!sessionId && !!action.cwd
    && snapshot.repo === action.cwd && snapshot.branch === action.branch
    && !!snapshot.context && typeof snapshot.context === "object"
    && typeof snapshot.policy?.ddd === "boolean" && typeof snapshot.policy?.contract === "boolean"
    && [snapshot.mainPushAllowlist, snapshot.strongImplModels, snapshot.editedRepos, snapshot.editedFiles]
      .every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

export function evaluateCachedAction(action: HarnessAction, snapshot: LocalPolicySnapshot): GateVerdict {
  return evaluateAction({
    ...snapshot.context, ...action,
    sessionModel: snapshot.context.model,
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
