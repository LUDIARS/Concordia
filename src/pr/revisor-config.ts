/**
 * Revisor 連携設定 (workflow token) の解決・保存・状態取得。
 *
 * @implements spec/feature/revisor-local-pr-submission.md — 6. token
 *
 * 設定の出所は 2 系統 (slack/config.ts と同じ方針):
 *   - DB (revisor_config): サービス内 (Web UI / API) から設定。 **優先**。
 *   - env (CONCORDIA_REVISOR_WORKFLOW_TOKEN): フォールバック。
 *
 * Revisor は loopback からの GET には token を要求しないが、 **変更系 (local PR 提出 /
 * merge / retry / リポ登録) には token を要求する**。 つまり Cc から local PR を扱うには
 * この値が要る。 Discord / Slack の bot token と同じく secret-box で暗号化して DB に
 * 置き、 平文では持たない。 status (GET) では値を返さず set 済みかだけを返す。
 */

import type { RevisorConfigRepo } from "../db/revisor-config-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { isEncrypted } from "../shared/secret-box.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("revisor-config");

/** revisor_config の DB キー。 */
const K_WORKFLOW_TOKEN = "workflow_token_enc";

export type RevisorTokenSource = "db" | "env" | "none";

export interface RevisorConfigStatus {
  /** token は値を返さず set 済みかだけ (redaction)。 */
  workflow_token_set: boolean;
  source: RevisorTokenSource;
}

/** 設定更新の patch。 undefined=据え置き / null・空文字=クリア (env へフォールバック) / 値=設定。 */
export interface RevisorConfigPatch {
  workflowToken?: string | null;
}

/** DB に保存された token を復号する (平文混入時はそのまま返す = 移行容易性)。 */
function decryptStored(box: SecretBox, stored: string | null): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored;
  try {
    return box.decrypt(stored);
  } catch (e) {
    log.warn(`stored revisor token decrypt failed (鍵不一致/破損?): ${(e as Error).message}`);
    return null;
  }
}

/**
 * 実効 token を解決する。 DB 優先、 未設定は env フォールバック。
 *
 * 呼び出しごとに解決するので、 Web UI から設定した値が **再起動なしで効く**
 * (クライアントは token を保持せずこの関数を都度呼ぶ)。
 */
export function resolveRevisorWorkflowToken(
  repo: RevisorConfigRepo,
  box: SecretBox,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stored = decryptStored(box, repo.get(K_WORKFLOW_TOKEN))?.trim();
  if (stored) return stored;
  return env.CONCORDIA_REVISOR_WORKFLOW_TOKEN?.trim() ?? "";
}

export function setRevisorConfig(
  repo: RevisorConfigRepo,
  box: SecretBox,
  patch: RevisorConfigPatch,
): void {
  if (patch.workflowToken === undefined) return;
  const value = patch.workflowToken?.trim() ?? "";
  if (!value) {
    repo.delete(K_WORKFLOW_TOKEN);
    log.info("revisor workflow token cleared (env フォールバックに戻す)");
    return;
  }
  repo.set(K_WORKFLOW_TOKEN, box.encrypt(value));
  log.info("revisor workflow token saved (encrypted)");
}

export function revisorConfigStatus(
  repo: RevisorConfigRepo,
  box: SecretBox,
  env: NodeJS.ProcessEnv = process.env,
): RevisorConfigStatus {
  const stored = decryptStored(box, repo.get(K_WORKFLOW_TOKEN))?.trim();
  const fromEnv = env.CONCORDIA_REVISOR_WORKFLOW_TOKEN?.trim();
  const source: RevisorTokenSource = stored ? "db" : fromEnv ? "env" : "none";
  return { workflow_token_set: source !== "none", source };
}
