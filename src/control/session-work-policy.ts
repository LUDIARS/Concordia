import type { PendingDelegationSpawn } from "./pending-delegation-spawns.js";
import { resolve } from "node:path";

export const SESSION_WORK_POLICY_SOURCE = "cc-session-work-policy";

export interface SessionWorkPolicyInput {
  repoPath: string;
  observedBranch: string | null;
  pendingSpawn: Pick<PendingDelegationSpawn, "branch" | "project"> | null;
  workspaceRoots: readonly string[];
}

export interface SessionWorkPolicyDecision {
  registeredBranch: string | null;
  branchMismatch: boolean;
  text: string;
}

/**
 * Every Session receives the same fail-closed work contract. This replaces
 * route-specific reminder prompts which repeatedly drifted out of sync.
 */
export function buildSessionWorkPolicy(input: SessionWorkPolicyInput): SessionWorkPolicyDecision {
  const requestedBranch = input.pendingSpawn?.branch ?? null;
  const observedBranch = input.observedBranch?.trim() || null;
  const registeredBranch = observedBranch ?? requestedBranch;
  const branchMismatch = Boolean(requestedBranch && observedBranch && requestedBranch !== observedBranch);
  const workspaceRoot = isWorkspaceRootCwd(input.repoPath, input.workspaceRoots);

  const lines = [
    "【Cc Session 作業ポリシー】",
    "- 作業対象プロジェクトを最初に特定してください。特定できなければ作業せず、ユーザに確認してください。",
    "- Castra / workspace root を作業ディレクトリにしてはいけません。個別プロジェクトの本体または worktree を使ってください。",
    "- 編集前に実際の checkout branch を確認し、その branch を Cc に登録してください。指定 branch と違う場合は作業を止めて報告してください。",
    "- Session の既定完了範囲は commit・push・PR 作成までです。PR 作成後は停止してください。",
    "- ユーザの明示指示がない限り、単体・統合・動作・起動を含むテストを実行しないでください。",
    "- ユーザの明示指示がない限り、merge・squash merge・auto-merge・main 更新を行わないでください。",
  ];
  if (requestedBranch) lines.push(`- Cc 指定 branch: ${requestedBranch}`);
  if (registeredBranch) lines.push(`- Cc 登録 branch: ${registeredBranch}`);
  if (branchMismatch) {
    lines.push(`⚠ branch mismatch: 指定=${requestedBranch} / 実際=${observedBranch}。修正またはユーザ確認まで編集禁止。`);
  }
  if (workspaceRoot) {
    lines.push(`⚠ cwd violation: ${input.repoPath} は workspace root です。個別プロジェクトを確認するまで編集禁止。`);
  }
  return { registeredBranch, branchMismatch, text: lines.join("\n") };
}

export function isWorkspaceRootCwd(cwd: string, workspaceRoots: readonly string[]): boolean {
  return workspaceRoots.some((root) => root.trim().length > 0 && samePath(root, cwd));
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function normalize(value: string): string {
  return resolve(value.trim()).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
