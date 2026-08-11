/**
 * 指示者ベースの認可付き Revisor local PR マージ (認可 → 実行 → 監査記録)。
 *
 * PR #297 で `POST /v1/prs/local/:id/merge` に入れた「指示者の役職を名簿で確認してから
 * マージする」流れを、 RWF (🔀) や Discord の操作面からも同じ手順で通せるよう 1 箇所に
 * まとめたもの。 判定そのものは `authorizeStaffCapability` (共通ヘルパー) が持ち、
 * ここは「誰の権限で・どの PR を・どこから」を残す責務だけを足す。
 *
 * 指示者の解決方法は入口ごとに違う (HTTP API はセッションの直近人間 inject、 RWF は
 * リアクションを付けた本人) ので、 解決済みの requester を受け取る形にしてある。
 *
 * @implements spec/feature/revisor-local-pr-submission.md — 管理者の指示に基づくセッションからのマージ
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W2 (RWF のマージ認可)
 */

import type { StaffPlatform, StaffRepo } from "../db/staff-repo.js";
import { authorizeStaffCapability } from "../staff/capability-authorization.js";
import type { StaffRole } from "../staff/roles.js";
import type { RevisorLocalPrMerger } from "./revisor-client.js";

/** マージを指示した人間。 platform は名簿を引く先を決める。 */
export interface LocalPrMergeRequester {
  platform: StaffPlatform;
  userId: string;
}

/** 監査記録 1 件。 「誰の権限で・どの PR を・どこから」を必ず含む。 */
export interface LocalPrMergeAudit {
  local_pr_id: string;
  session_id: string;
  /** 実行の出所 ("api" / "reaction-workflow" / "discord-panel" 等)。 */
  source: string;
  authorizer: { platform: StaffPlatform; user_id: string; role: StaffRole | null };
}

export interface LocalPrMergeDeps {
  /** platform ごとの役職を live 参照する。 */
  staff: Pick<StaffRepo, "roleOf">;
  /** Revisor の local PR マージ窓口。 */
  merger: RevisorLocalPrMerger;
  /** 成功時のみ呼ばれる監査シンク (構造化ログ + session event)。 */
  audit: (record: LocalPrMergeAudit) => void;
  /**
   * Revisor の生の失敗内容を残すローカルログ。 呼び出し元へは返さない
   * (endpoint / 設定情報を含み得るため)。
   */
  logError?: (message: string) => void;
}

export interface LocalPrMergeRequest {
  localPrId: string;
  sessionId: string;
  requester: LocalPrMergeRequester;
  source: string;
}

export type LocalPrMergeResult =
  | { merged: true; role: StaffRole | null }
  | { merged: false; reason: "not_authorized"; detail: string }
  | { merged: false; reason: "merge_failed"; detail: string };

/**
 * Revisor へ返す失敗文言は固定にする。 上流の生メッセージは endpoint や設定情報を
 * 含み得るので、 呼び出し元 (HTTP 応答 / chat 投稿) へは通さない。
 */
export const LOCAL_PR_MERGE_FAILURE_DETAIL = "Revisor local PR merge failed";

/** 指示者の `merge_pr` を確認してから local PR をマージし、 通った場合だけ監査を残す。 */
export async function mergeLocalPrForRequester(
  deps: LocalPrMergeDeps,
  request: LocalPrMergeRequest,
): Promise<LocalPrMergeResult> {
  const authorization = authorizeStaffCapability(
    deps.staff,
    request.requester.platform,
    request.requester.userId,
    "merge_pr",
  );
  if (!authorization.allowed) {
    return { merged: false, reason: "not_authorized", detail: authorization.detail };
  }

  try {
    await deps.merger.mergeLocalPr(request.localPrId);
  } catch (error) {
    deps.logError?.(error instanceof Error ? error.message : String(error));
    return { merged: false, reason: "merge_failed", detail: LOCAL_PR_MERGE_FAILURE_DETAIL };
  }

  deps.audit({
    local_pr_id: request.localPrId,
    session_id: request.sessionId,
    source: request.source,
    authorizer: {
      platform: request.requester.platform,
      user_id: request.requester.userId,
      role: authorization.role,
    },
  });
  return { merged: true, role: authorization.role };
}
