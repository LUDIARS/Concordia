/**
 * 報告者・権限者へ返す文 (spec/feature/bug-bounty.md §5 §7)。 純関数。
 *
 * 原文 (何が起きたか・再現手順) は入れない。 AI が書いた理由・題名は報告由来の文として扱い、
 * mention (@everyone / @here / <@...>) とリンクの自動展開にならないよう無効化する。
 * 本人への mention は通知の adapter が構造化フィールドで付ける (本文の文字列では mention しない)。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 * @implements SPEC-BOUNTY-CLOSE
 */

import type { BountyReportRow } from "../db/bounty-reports-repo.js";
import { BOUNTY_REWARD_SKIP_LABEL, type BountyRewardSkip } from "./reward-decision.js";

const ZERO_WIDTH_SPACE = "​";
const MAX_QUOTED_CHARS = 500;

/** 報告由来の文を、通知に載せても mention・リンク展開にならない形へ。 */
export function neutralizeReportText(text: string | null | undefined, max = MAX_QUOTED_CHARS): string {
  const flat = (text ?? "").replace(/\s+/gu, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped
    .replace(/@/gu, `@${ZERO_WIDTH_SPACE}`)
    .replace(/<(?=[@#:&!])/gu, `<${ZERO_WIDTH_SPACE}`)
    .replace(/https?:\/\//giu, (scheme) => `${scheme.slice(0, -2)}${ZERO_WIDTH_SPACE}//`);
}

const VERDICT_LABEL: Record<string, string> = {
  accepted: "採用",
  duplicate: "重複",
  rejected: "対象外",
  needs_info: "情報不足",
};

/** 仕分けの結果を受付口へ返す文。 */
export function triageReplyMessage(report: Pick<BountyReportRow, "id" | "verdict" | "verdict_reason" | "duplicate_of" | "project_code">): string {
  const label = VERDICT_LABEL[report.verdict ?? ""] ?? "未判定";
  const lines = [`バグ報告 \`${report.id}\` の仕分け結果: **${label}** (対象: ${report.project_code ?? "未特定"})`];
  if (report.verdict === "duplicate" && report.duplicate_of) lines.push(`重複先: \`${report.duplicate_of}\``);
  if (report.verdict_reason && report.verdict !== "accepted") lines.push(`理由: ${neutralizeReportText(report.verdict_reason)}`);
  if (report.verdict === "needs_info") {
    lines.push("足りない情報を書き足してください (Discord は `/bug amend`、セッションは `POST /v1/bounty/reports/:id/amend`)。");
  }
  if (report.verdict === "rejected" || report.verdict === "duplicate") {
    lines.push("判定に異議があれば 1 回だけ再審を求められます (`/bug appeal`)。");
  }
  if (report.verdict === "accepted") lines.push("修正のタスクを作り、反映を確認したらここへ知らせます。");
  return lines.join("\n");
}

/** 反映を確認したことを受付口へ返す文。 */
export function deployedReplyMessage(input: {
  reportId: string;
  title: string | null;
  rewardTokens: number | null;
  rewardSkip: BountyRewardSkip | null;
}): string {
  const lines = [`バグ報告 \`${input.reportId}\` の修正が反映されました: ${neutralizeReportText(input.title ?? "(題名なし)", 120)}`];
  if (input.rewardTokens !== null) lines.push(`報奨として ${input.rewardTokens.toLocaleString("en-US")} トークンを報酬分へ加算しました。`);
  else if (input.rewardSkip) lines.push(`報奨なし: ${BOUNTY_REWARD_SKIP_LABEL[input.rewardSkip]}。`);
  return lines.join("\n");
}

/** 受付の応答に添える、報奨の対象外の知らせ。 対象になりうるなら null。 */
export function rewardIneligibilityNotice(skip: BountyRewardSkip | null): string | null {
  return skip ? `この報告は報奨の対象外です (${BOUNTY_REWARD_SKIP_LABEL[skip]})。` : null;
}

/** 権限者への知らせ。 本文は入れず、報告 id と事実だけ。 */
export function authorityNotice(kind: "triage_escalated" | "appeal" | "actio_done" | "hotfix_failed", reportId: string, detail?: string): string {
  const suffix = detail ? ` (${neutralizeReportText(detail, 200)})` : "";
  switch (kind) {
    case "triage_escalated":
      return `バグ報告 \`${reportId}\` の仕分けが 3 回失敗しました。WebUI のバグバウンティから判定してください${suffix}。`;
    case "appeal":
      return `バグ報告 \`${reportId}\` に再審の申し出がありました。WebUI のバグバウンティで決めてください${suffix}。`;
    case "actio_done":
      return `バグ報告 \`${reportId}\` の Actio タスクが done になりました。反映を確かめたら \`/bug close\` で閉じてください (自動では閉じません)。`;
    case "hotfix_failed":
      return `バグ報告 \`${reportId}\` の hotfix の委託が失敗・停止したため、修正待ちへ戻しました${suffix}。自動では起動し直しません。`;
  }
}
