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
    "- ユーザに資料（設計書・調査報告・タスク文書など）を共有するときは、リンクやローカルパスだけで済ませず attachment を添付してください。現在の Discord スレッドへ届けるには、自分の Lictor sidecar へ POST http://127.0.0.1:$LICTOR_PORT/v1/internal/send-file で { files: [絶対パス], caption: 説明 } を送ってください。この専用経路は channel=system と自分の session 送信先を刻印します。`/v1/chat` の channel=報告 は共通報告チャンネル宛てなので、セッションへの資料送信には使わないでください。files は workspace root 配下または一時ディレクトリ内に限り、範囲外や秘密らしき名前は拒否されます。送信権限・共有範囲を守り、API 受付だけで到着済みとはせず、送信先と Discord 投稿の配送記録を確認してください。添付失敗・配送未確認はその旨を明記してください。",
    "- 資料は Discord 内で内容を読める形にしてください。短い資料は本文も caption に載せ、長い資料は要点を caption に載せて全文を UTF-8 の .txt として添付してください。必要に応じて原本も併せて添付し、外部リンクを開くことを内容確認の必須手順にしないでください。端末での添付プレビューは未確認なら確認済みと扱わないでください。",
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
