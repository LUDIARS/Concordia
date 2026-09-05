/**
 * Issue 経路のモデル選定に必要な I/O (テンプレ一覧 + 週間残量) を集めて
 * dispatch の `selectModel` に差せる形にする。
 *
 * 判断そのものは issue-model-selection.ts の純関数。 ここは「今のテンプレ」と
 * 「今の残量」を渡すだけに保つ (テストは純関数側で書く)。
 *
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */

import type { DelegationTemplateRow } from "../db/delegation-repo.js";
import { forumModelChoices } from "../delegation/forum-model-selection.js";
import { collectForumModelUsage } from "../delegation/forum-model-usage.js";
import {
  selectIssueBodyModel,
  selectIssueFixModel,
  type IssueModelSelection,
} from "./issue-model-selection.js";

export interface IssueModelResolverDeps {
  listTemplates: () => readonly DelegationTemplateRow[];
  log: { warn: (message: string) => void; info?: (message: string) => void };
  /** テスト差し替え用。 */
  collectUsage?: typeof collectForumModelUsage;
  nowSec?: () => number;
}

/**
 * 起動候補は delegation テンプレ (opus-mid / sol-mid 等) が正本。 SQLite の
 * `is_active: number` を forum 側の boolean 形へ寄せてから候補解決に渡す。
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */
export function createIssueModelResolver(
  deps: IssueModelResolverDeps,
): (input: { issueBody: string }) => Promise<IssueModelSelection | null> {
  return async ({ issueBody }) => {
    const choices = forumModelChoices(
      deps.listTemplates().map((template) => ({
        call_name: template.call_name,
        is_active: template.is_active === 1,
        emoji: template.emoji,
        target_provider: template.target_provider,
        model: template.model,
      })),
    );
    if (choices.length === 0) return null;
    const explicit = selectIssueBodyModel(issueBody, choices);
    if (explicit) return explicit;
    const usage = await (deps.collectUsage ?? collectForumModelUsage)({ log: deps.log });
    return selectIssueFixModel({
      issueBody,
      choices,
      codexWeekly: usage.codexWeekly,
      claudeWeekly: usage.claudeWeekly,
      nowSec: deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000),
    });
  };
}
