/**
 * checkout 照会で受け取る repo 識別子の検証と正規化。
 *
 * Revisor は登録 checkout を前進させてよいかを Cc へ照会する
 * (Revisor `spec/feature/checkout-publication.md` §3)。 その際に渡ってくる
 * `repo_origin` は **userinfo を含まない正規化済み識別子だけ**を受ける。
 * 資格情報付きの remote URL (`https://user:token@host/owner/repo.git`) を受け取って
 * ログやイベントへ流すと、 照会経路がそのまま secret の漏洩経路になる。
 *
 * ここは純関数のみ。 DB も HTTP も触らない。
 */

import { isOwnerRepo, normalizeRepoOrigin } from "../pr/normalize.js";
import { normalizeRepoKey } from "../control/conflict-scope.js";

/** 識別子として受け付けなかった理由 (機械可読)。 */
export type OriginRejectReason =
  | "empty"
  | "credentials_present"
  | "not_canonical";

export type OriginCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: OriginRejectReason };

/**
 * `repo_origin` を検証して canonical な `owner/repo` に落とす。
 *
 * 受け付ける形:
 *   - `Owner/Repo`
 *   - `https://host/Owner/Repo(.git)` / `git@host:Owner/Repo.git` (userinfo 無し)
 * 拒否する形:
 *   - userinfo (`user@` / `user:pass@`) を含む URL → `credentials_present`
 *   - owner/repo に落とせない任意文字列 (ローカルパス等) → `not_canonical`
 *
 * 拒否理由は識別子だけを返す。 呼び出し側は**原文をログ・イベントへ出さない**こと。
 */
export function checkRepoOrigin(raw: string | undefined | null): OriginCheck {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "empty" };
  if (hasCredentials(value)) return { ok: false, reason: "credentials_present" };
  const normalized = normalizeRepoOrigin(value);
  if (!isOwnerRepo(normalized)) return { ok: false, reason: "not_canonical" };
  return { ok: true, origin: normalized };
}

/**
 * URL / SCP 形式の userinfo を検出する。
 * `git@github.com:Owner/Repo.git` は userinfo ではなく SSH の user 部で、 資格情報を
 * 含まないため通す。 それ以外の `@` (URL の authority 内 / `user:pass@`) は拒否。
 */
function hasCredentials(value: string): boolean {
  const scheme = value.match(/^([a-zA-Z][\w+.-]*):\/\/([^/]*)/);
  if (scheme) return scheme[2].includes("@");
  // scp-like: user@host:path。 password 埋め込み (`user:pass@host:path`) は拒否する。
  const scp = value.match(/^([^@/]+)@[\w.-]+:/);
  if (scp) return scp[1].includes(":");
  return value.includes("@");
}

/** `owner/repo` の repo 名 (末尾要素) を小文字で返す。 */
export function repoNameOf(origin: string): string {
  const tail = origin.split("/").pop() ?? "";
  return tail.replace(/\.git$/i, "").toLowerCase();
}

/** repo_path の末尾ディレクトリ名を小文字で返す (Windows の区切り揺れを吸収)。 */
export function repoDirNameOf(repoPath: string): string {
  const key = normalizeRepoKey(repoPath);
  return key.split("/").pop() ?? "";
}
