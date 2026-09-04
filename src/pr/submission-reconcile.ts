/**
 * local PR 提出が「結果不明」で終わったときの後追い確認。
 *
 * Cc → Revisor の提出 POST には client 側の timeout (既定 15 秒) がある。 Revisor は
 * 受理後に base/head の worktree を作るので、 大きいリポジトリや審査混雑時は応答が
 * それを超える。 このとき Cc は abort 例外を掴んで `{submitted:false, reason:"error"}` を
 * 返すが、 **Revisor 側では PR が作られている**。 提出者には「失敗」に見えるので、
 * 同じブランチをもう一度出しに行って二重提出になる。
 *
 * 「応答が無かった」 は「実行されなかった」 ではない。 timeout / 接続断のように
 * **結果が確定していない失敗**に限り、 Revisor の一覧を引き直して実際に PR が
 * できていないかを確認する。 4xx のような確定的な失敗では引き直さない
 * (無駄な往復になるうえ、 別セッションが同時に出した PR を自分のものと誤認しうる)。
 */

import type { RevisorLocalPrSummary } from "./revisor-local-pr-client.js";
import { findOpenLocalPrForBranch } from "./local-pr-lookup.js";

/**
 * 結果が確定していない失敗か。 abort (client timeout) と、 応答に到達しなかった
 * ネットワーク層の失敗を対象にする。 Revisor が status を返した失敗は含めない。
 *
 * @implements SPEC-REVISOR-LOCAL-PR-SUBMISSION-RECONCILE
 */
export function isInconclusiveSubmissionError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  // Revisor が status 付きで返した失敗 (`Revisor /v1/... failed (409)`) は確定的。
  if (/failed \(\d{3}\)/.test(message)) return false;
  return /abort|timeout|timed out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i.test(message);
}

export interface ReconcileInput {
  repository: string | null;
  branch: string;
  /** Revisor の open な local PR 一覧を引き直す関数。 */
  listOpenPullRequests: () => Promise<readonly RevisorLocalPrSummary[]>;
}

/**
 * 提出が結果不明で終わった後、 実際に PR ができていれば返す。 できていなければ null。
 * 引き直し自体が失敗した場合も null (元の失敗を上書きしない)。
 *
 * @implements SPEC-REVISOR-LOCAL-PR-SUBMISSION-RECONCILE
 */
export async function reconcileInconclusiveSubmission(
  input: ReconcileInput,
): Promise<RevisorLocalPrSummary | null> {
  if (!input.repository || !input.branch) return null;
  let pullRequests: readonly RevisorLocalPrSummary[];
  try {
    pullRequests = await input.listOpenPullRequests();
  } catch {
    return null;
  }
  return findOpenLocalPrForBranch(input.repository, input.branch, pullRequests) ?? null;
}
