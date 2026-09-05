/**
 * GitHub Issue 起点の委託を「どのモデルで起動するか」だけ決める (2026-09-05 neco 指示)。
 *
 * 2 段:
 *  1. Issue 本文がモデルを指定していればそれに従う。
 *  2. 指定が無ければ Opus / Sol のうち週間枠の残量が余っている方で起動する。
 *
 * モデル id は delegation テンプレ (opus-mid / sol-mid) が正本なので、 候補の解決も
 * 残量比較も Session forum と同じ関数を使う。 ここで表を持ち直すと、 テンプレのモデルを
 * 更新したときに Issue 経路だけ古い id で起動する。
 *
 * 本文からの抽出は **カタログにある候補との一致だけ**を見る。 Issue 本文は外部入力で
 * あり指示ではない、 という不変条件はここでも変えない — 本文が指せるのは「起動モデル」
 * という 1 つの enum であって、 手順や権限ではない。
 *
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */

import {
  matchExplicitForumModel,
  normalizeForumEffort,
  type ForumEffort,
  type ForumModelChoice,
  type ForumModelNick,
  pickProviderFamilyByCostRatio,
  type ForumProviderFamily,
  type WeeklyQuotaWindow,
} from "../delegation/forum-model-selection.js";
import type { DelegationProvider } from "../db/delegation-repo.js";

/** 本文指定が無いときの 2 択。 Opus (Claude 系) と Sol (Codex 系) の残量勝負にする。 */
export const ISSUE_FALLBACK_NICKS: readonly ForumModelNick[] = ["opus", "sol"];

/** 系統 → その系統で使う既定 nickname。 */
const FAMILY_NICK: Record<ForumProviderFamily, ForumModelNick> = { claude: "opus", codex: "sol" };

export interface IssueModelSelection {
  nick: ForumModelNick;
  provider: DelegationProvider;
  model: string;
  effort: ForumEffort;
  /** `issue_body` = 本文が指定した / `usage_balance` = 週間残量で選んだ。 */
  source: "issue_body" | "usage_balance";
  /** run ログと Issue 側の説明に載せる短い根拠。 */
  reason: string;
}

export interface IssueModelSelectionInput {
  /** 保存ファイルの見出しやメタデータを除いた、元の Issue 本文。 */
  issueBody: string;
  choices: readonly ForumModelChoice[];
  codexWeekly: WeeklyQuotaWindow | null;
  claudeWeekly: WeeklyQuotaWindow | null;
  nowSec: number;
}

/**
 * `model: opus` / `モデル: sol` のように **行として明示**された指定を拾う。
 * 本文中でモデル名にたまたま触れただけの文と、 起動指定とを区別するための厳格経路。
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */
export function matchIssueModelDirective(
  body: string,
  choices: readonly ForumModelChoice[],
): ForumModelChoice | null {
  const directive = /^[\s>*\-#]*(?:model|モデル)\s*[:：=]\s*(.+)$/im.exec(body);
  const requested = directive?.[1]?.trim().toLowerCase();
  if (!requested) return null;
  return choices.find(
    (choice) => choice.nick === requested || choice.model.toLowerCase() === requested,
  ) ?? null;
}

/**
 * Issue 本文だけからモデル指定を解決する。指定が無いときの残量取得は I/O 層に委ねる。
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */
export function selectIssueBodyModel(
  issueBody: string,
  choices: readonly ForumModelChoice[],
): IssueModelSelection | null {
  const directive = matchIssueModelDirective(issueBody, choices);
  const matched = directive
    ? { choice: directive }
    : matchExplicitForumModel("", issueBody, choices);
  if (!matched) return null;
  return {
    nick: matched.choice.nick,
    provider: matched.choice.provider as DelegationProvider,
    model: matched.choice.model,
    // Issue 本文に許可する上書きはモデル enum だけ。forum 用 matcher が拾う
    // effort 語彙は、Issue の通常文を実行設定として解釈しない。
    effort: normalizeForumEffort(matched.choice.provider),
    source: "issue_body",
    reason: `Issue 本文の指定 (${matched.choice.nick})`,
  };
}

/**
 * 起動モデルを決める。 候補が 1 つも解決できなければ null = テンプレ既定のまま起動する
 * (モデルを決められないことを理由に Issue の修正を止めない)。
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */
export function selectIssueFixModel(input: IssueModelSelectionInput): IssueModelSelection | null {
  const explicit = selectIssueBodyModel(input.issueBody, input.choices);
  if (explicit) {
    return explicit;
  }

  const candidates = input.choices.filter((choice) => ISSUE_FALLBACK_NICKS.includes(choice.nick));
  if (candidates.length === 0) return null;

  const picked = pickProviderFamilyByCostRatio({
    codexWeekly: input.codexWeekly,
    claudeWeekly: input.claudeWeekly,
    nowSec: input.nowSec,
  });
  // 選ばれた系統の候補が無ければもう片方で起動する。 「残量で選ぶ」より
  // 「起動できる」を優先する — 候補は 2 つしかなく、 どちらも妥当な既定。
  const choice = candidates.find((entry) => entry.nick === FAMILY_NICK[picked.family]) ?? candidates[0]!;
  return {
    nick: choice.nick,
    provider: choice.provider as DelegationProvider,
    model: choice.model,
    effort: normalizeForumEffort(choice.provider),
    source: "usage_balance",
    reason: formatUsageReason(choice.nick, picked.claudeRatio, picked.codexRatio),
  };
}

/** 残量比を人が読める 1 行にする。 @implements spec/feature/github-issue-workflow.md — モデル選定 */
function formatUsageReason(
  nick: ForumModelNick,
  claudeRatio: number | null,
  codexRatio: number | null,
): string {
  if (claudeRatio === null && codexRatio === null) {
    return `週間残量を取得できず既定で ${nick}`;
  }
  const format = (ratio: number | null) => (ratio === null ? "不明" : ratio.toFixed(1));
  return `週間残量比 opus ${format(claudeRatio)} / sol ${format(codexRatio)} で ${nick}`;
}
