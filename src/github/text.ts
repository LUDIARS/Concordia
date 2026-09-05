/**
 * Issue コメントと GitHub PR 本文の組み立て (純関数)。
 *
 * 「何を直したか」と「どうなったか」を PR 本文に、 PR へのリンクを Issue に載せる
 * (2026-09-05 neco 指示)。 進捗・打ち切りも必ずコメントする — 押した人から見て
 * 黙って消える状態を作らない。
 *
 * @implements spec/feature/github-issue-workflow.md — パイプライン
 */

import type { GithubIssueRunRow } from "../db/github-issue-runs-repo.js";
import { redactSecrets } from "../shared/redact-secrets.js";

const SIGNATURE = "\n\n<sub>Concordia GitHub Issue ワークフロー</sub>";
const MAX_PUBLIC_DETAIL_LENGTH = 4_000;
const PRIVATE_ENDPOINT_PATTERN = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?\S*/gi;
const WINDOWS_LOCAL_PATH_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\)[^\s`<>]+/g;
const UNIX_LOCAL_PATH_PATTERN = /\/(?:Users|home|tmp|var|etc)\/[^\s`<>]+/g;

/** GitHub へ出す自由記述から資格情報・ローカルパス・private endpoint を除く。 */
export function sanitizeGithubPublicText(value: string): string {
  const sanitized = redactSecrets(value)
    .replace(PRIVATE_ENDPOINT_PATTERN, "[PRIVATE_ENDPOINT]")
    .replace(WINDOWS_LOCAL_PATH_PATTERN, "[LOCAL_PATH]")
    .replace(UNIX_LOCAL_PATH_PATTERN, "[LOCAL_PATH]");
  return sanitized.length > MAX_PUBLIC_DETAIL_LENGTH
    ? `${sanitized.slice(0, MAX_PUBLIC_DETAIL_LENGTH - 1)}…`
    : sanitized;
}

/**
 * 承認待ちで止めたことを Issue に返す。 「誰が承認するのか」「どこで承認するのか」は
 * 書かない — 内部の運用面を第三者へ説明しないため。
 * @implements spec/feature/github-issue-workflow.md — 承認
 */
export function awaitingApprovalComment(run: GithubIssueRunRow): string {
  return [
    `\`${run.label}\` ラベルを受け付けました。担当者の確認待ちです。`,
    "",
    "確認が済むと修正を始め、結果をここに書きます。着手しないと判断した場合も、その旨を返します。",
  ].join("\n") + SIGNATURE;
}

/**
 * 承認せずに終える場合。 理由から公開禁止情報だけを伏せて載せる。
 * @implements spec/feature/github-issue-workflow.md — 承認
 */
export function approvalRejectedComment(reason: string): string {
  const publicReason = sanitizeGithubPublicText(reason).trim();
  return [
    "確認の結果、自動修正は行わないことになりました。",
    "",
    "### 理由",
    publicReason === "" ? "(理由の記載なし)" : publicReason,
  ].join("\n") + SIGNATURE;
}

export function acceptedComment(run: GithubIssueRunRow): string {
  return [
    `\`${run.label}\` ラベルを受け付けました。修正を試みます。`,
    "",
    // project_code は内部の登録名なので公開 Issue へ出さず、既に公開されている repo 名だけを使う。
    `- 対象: \`${run.repo_origin}\``,
    `- 作業ブランチ: \`${run.branch}\``,
    "",
    "修正できた場合は審査 (Revisor) を通してから Pull Request を作り、ここにリンクを返します。"
    + "コード起因でないと判断した場合は、その理由をここに書きます。",
  ].join("\n") + SIGNATURE;
}

export function publishedComment(input: { prUrl: string; summary: string }): string {
  const summary = sanitizeGithubPublicText(input.summary).trim();
  return [
    `Pull Request を作成しました: ${input.prUrl}`,
    "",
    "### 修正内容",
    summary === "" ? "(委託からの要約なし — PR の差分を参照)" : summary,
  ].join("\n") + SIGNATURE;
}

export function skippedComment(reason: string): string {
  const publicReason = sanitizeGithubPublicText(reason).trim();
  return [
    "コードの修正は行いませんでした。",
    "",
    "### 理由",
    publicReason === "" ? "(理由の報告なし)" : publicReason,
  ].join("\n") + SIGNATURE;
}

export function failedComment(reason: string): string {
  const publicReason = sanitizeGithubPublicText(reason).trim();
  return [
    "自動修正は完了しませんでした。人による対応が要ります。",
    "",
    "### 状況",
    publicReason === "" ? "(理由の報告なし)" : publicReason,
  ].join("\n") + SIGNATURE;
}

/**
 * GitHub PR の本文。 審査を通った事実と、 委託が報告した修正内容を載せ、
 * `Closes` で Issue に紐付ける。
 */
export function pullRequestBody(input: {
  run: GithubIssueRunRow;
  summary: string;
  reviewNote: string;
}): string {
  const summary = sanitizeGithubPublicText(input.summary).trim();
  return [
    `Closes #${input.run.issue_number}`,
    "",
    "### 修正内容",
    summary === "" ? "(委託からの要約なし — 差分を参照)" : summary,
    "",
    "### 対応結果",
    input.reviewNote,
    `- 起票: ${input.run.issue_url}`,
    `- 依頼 (ラベル付与): @${input.run.actor}`,
    "",
    "<sub>Concordia が GitHub Issue ワークフローで作成しました。"
    + "変更は Revisor local PR の審査を通ってから push しています。</sub>",
  ].join("\n");
}

export function pullRequestTitle(run: GithubIssueRunRow): string {
  const title = run.issue_title.trim() === "" ? `issue #${run.issue_number}` : run.issue_title.trim();
  // GitHub の PR タイトルは長すぎると読みにくいだけなので、 頭を残して切る。
  const trimmed = title.length > 120 ? `${title.slice(0, 117)}...` : title;
  return `fix: ${trimmed} (#${run.issue_number})`;
}
