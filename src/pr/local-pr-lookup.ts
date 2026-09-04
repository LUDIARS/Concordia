/**
 * local PR / 登録リポジトリの同定規則。
 *
 * 「そのセッションが提出した PR はどれか」「このリポジトリは Revisor に登録済みか」を
 * 決める規則の正本。 提出の二重防止・後追い確認 (submission-reconcile) ・RWF / Discord
 * 操作面のマージ対象選択が同じ関数を使う。 片方だけずれると「提出済みなのにマージ対象が
 * 見つからない」という無言の食い違いになるので、 判定を写して増やさないこと。
 *
 * 提出フロー (local-pr-submission) から独立させてあるのは、 後追い確認がこの規則だけを
 * 必要とし、 提出フロー全体を引き込むと循環参照になるため。
 */

import { normalizeRepoOrigin } from "./normalize.js";
import type { RevisorLocalPrSummary, RevisorRepositoryRegistration } from "./revisor-local-pr-client.js";

/**
 * セッションの repo_origin と Revisor の登録リポジトリを突き合わせる。
 *
 * `sessions.repo_origin` は hook が `git config --get remote.origin.url` をそのまま
 * 入れるので `https://github.com/LUDIARS/Concordia.git` や `git@github.com:...` の形で
 * 来る。 一方 Revisor の登録は `owner/repo`。 生値のまま比較すると**どのセッションも
 * 未登録扱いになり、 レビューが 1 件も発火しない** — 無言で発火経路が死ぬという、
 * この機能が潰しに来た障害そのものになる。 双方 owner/repo に寄せてから比較する。
 */
export function findRegistration(
  repository: string | null,
  registrations: readonly RevisorRepositoryRegistration[],
): RevisorRepositoryRegistration | undefined {
  const key = repository ? normalizeRepoOrigin(repository).toLowerCase() : "";
  if (!key) return undefined;
  return registrations.find((row) => normalizeRepoOrigin(row.repository).toLowerCase() === key);
}

/**
 * セッションの (リポジトリ, ブランチ) に一致する open な local PR を探す。
 *
 * 「そのセッションが提出した PR はどれか」の同定規則の正本。 提出の二重防止と、
 * RWF / Discord 操作面からのマージ対象選択が同じ規則を使う (片方だけずれると
 * 「提出済みなのにマージ対象が見つからない」という無言の食い違いになる)。
 * リポジトリは表記ゆれを正規化して比較し、 ブランチ名は git と同じく大文字小文字を区別する。
 */
export function findOpenLocalPrForBranch(
  repository: string | null,
  branch: string | null,
  pullRequests: readonly RevisorLocalPrSummary[],
): RevisorLocalPrSummary | undefined {
  const head = branch?.trim() ?? "";
  if (!head) return undefined;
  return listOpenLocalPrsForRepository(repository, pullRequests).find((pr) => pr.headRef === head);
}

/** 同じリポジトリの open な local PR (操作面の選択肢に出す)。 表記ゆれは正規化して比較する。 */
export function listOpenLocalPrsForRepository(
  repository: string | null,
  pullRequests: readonly RevisorLocalPrSummary[],
): RevisorLocalPrSummary[] {
  const key = repository ? normalizeRepoOrigin(repository).toLowerCase() : "";
  if (!key) return [];
  return pullRequests.filter((pr) =>
    pr.status === "open" && normalizeRepoOrigin(pr.repository).toLowerCase() === key);
}
