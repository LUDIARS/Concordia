import type { PendingDelegationSpawn } from "./pending-delegation-spawns.js";
import { resolve } from "node:path";

export const SESSION_WORK_POLICY_SOURCE = "cc-session-work-policy";
export const EXPLICIT_WORKING_BRANCH_METADATA_KEY = "cc_explicit_working_branch";
export const WORKSPACE_ROOT_METADATA_KEY = "cc_workspace_root";

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
  const isCastraCwd = isWorkspaceRootCwd(input.repoPath, input.workspaceRoots);
  // Castra is an umbrella for cross-project investigation, not an
  // implementation checkout. Do not register its observed branch as a working
  // branch; an intentional child-project spawn may still carry its request.
  const registeredBranch = isCastraCwd ? requestedBranch : observedBranch ?? requestedBranch;
  const branchMismatch = !isCastraCwd && Boolean(requestedBranch && observedBranch && requestedBranch !== observedBranch);

  const lines = [
    "【Cc Session 作業ポリシー】",
    "- 作業対象プロジェクトを最初に特定してください。特定できなければ作業せず、ユーザに確認してください。",
    "- Castra (workspace root) を cwd にした横断作業・調査は許可されます。ただし Castra 自体への破壊的 git 操作 (commit・push・checkout・reset 等) は行わないでください。個別プロジェクトへの変更は、そのプロジェクトの本体または worktree 側で行ってください。",
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
  if (isCastraCwd) {
    lines.push(`⚠ Castra 破壊的 git 操作ガード: ${input.repoPath} は Castra (workspace root) です。Castra 自体への commit・push・checkout・reset 等は禁止。個別プロジェクトの編集は当該プロジェクトのディレクトリ/worktree で行ってください。`);
  }
  return { registeredBranch, branchMismatch, text: lines.join("\n") };
}

export interface CastraSessionBinding {
  repoPath: string;
  targetProject: string | null;
  metadata: string | null;
}

/**
 * Whether Cc must treat this as a Castra-rooted session, even after an
 * implementation binding replaces repo_path with a child worktree.
 */
export function isCastraSessionBinding(
  session: CastraSessionBinding,
  workspaceRoots: readonly string[],
): boolean {
  if (!session.targetProject?.trim()) return false;
  return isWorkspaceRootCwd(session.repoPath, workspaceRoots)
    || isWorkspaceRootCwd(readMetadataString(session.metadata, WORKSPACE_ROOT_METADATA_KEY) ?? "", workspaceRoots);
}

export function readExplicitWorkingBranch(metadata: string | null): string | null {
  return readMetadataString(metadata, EXPLICIT_WORKING_BRANCH_METADATA_KEY);
}

/**
 * cwd が設定済み workspace/Castra root のいずれかと完全一致するか。
 *
 * これ自体はもう Session cwd の可否判定には使わない (workspace root を cwd にする
 * ことは許可されている)。 buildSessionWorkPolicy がこの真偽値を、 Castra 自体への
 * 破壊的 git 操作を控えるよう促す advisory 文言を足すかどうかの判定にのみ使う。
 */
export function isWorkspaceRootCwd(cwd: string, workspaceRoots: readonly string[]): boolean {
  if (!cwd.trim()) return false;
  return workspaceRoots.some((root) => root.trim().length > 0 && samePath(root, cwd));
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function normalize(value: string): string {
  return resolve(value.trim()).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function readMetadataString(metadata: string | null, key: string): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
