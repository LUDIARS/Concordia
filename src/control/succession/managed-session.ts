/**
 * セッションの寿命を別の管理が持つか (委託子・パートタイマー・リポ担当) の判定 (純関数)。
 *
 * 委託子とパートタイマーは delegation run 由来で、 run 管理 (watchdog・退勤) が寿命を持つ。
 * 自動引き継ぎ・リポ担当の契機はこれらに掛けない (§2.1 managed_elsewhere / §3.2 再帰防止)。
 *
 * @implements spec/feature/session-auto-succession.md §2.1, §3.2
 */

import { REPO_AGENT_OF_METADATA_KEY } from "./repo-agents-state.js";

const DELEGATION_KEYS = ["delegation_run_id", "delegation_parent_session_id"] as const;

/** metadata JSON 文字列をオブジェクトへ。 壊れた値・非オブジェクトは空。 */
export function parseSessionMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // 壊れた metadata は他の処理と同じく空扱い (この判定では「管理なし」側に倒れる)。
    return {};
  }
}

function hasValue(metadata: Record<string, unknown>, key: string): boolean {
  const value = metadata[key];
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

/** 委託子・パートタイマー (delegation run 由来)。 */
export function isDelegatedSession(metadata: Record<string, unknown>): boolean {
  return DELEGATION_KEYS.some((key) => hasValue(metadata, key));
}

/** リポ担当エージェント自身。 */
export function isRepoAgentSession(metadata: Record<string, unknown>): boolean {
  return hasValue(metadata, REPO_AGENT_OF_METADATA_KEY);
}
