/**
 * リアクションワークフローの操作面 (受付 / 結果) — Discord。
 *
 * 描画は `interaction-ui.ts` の `buildPanel` に一本化する。 RWF の受付・結果は
 * これまで素の文字列返信だったが、 W4 で PR 操作面と同じ embed に揃える。
 * アクションの語彙・説明は RWF エンジン (`WORKFLOW_ACTION_HELP`) が正本で、
 * ここは表示への写像だけを持つ。
 *
 * @implements spec/feature/reaction-workflow.md §3
 */

import type { WorkflowAction } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { buildPanel, type RenderedPanel } from "./interaction-ui.js";

/** 発火を受け付けた直後に出す報告面。操作ボタンは付けない。 */
export function buildRwfAckPanel(input: {
  action: WorkflowAction;
  emoji: string;
  actorId: string;
}): RenderedPanel {
  const rwf = getRwf();
  const help = rwf.WORKFLOW_ACTION_HELP[input.action];
  return buildPanel({
    title: `${input.emoji} ${help?.label ?? input.action} を受け付けました`,
    description: help?.summary ?? "",
    tone: "info",
    fields: [
      { name: "実行手段", value: help?.mode ?? "-", inline: false },
      { name: "実行者", value: `<@${input.actorId}>`, inline: true },
    ],
  });
}

/** 実行結果の面。 成否で色を変えるだけで、 文言はワークフロー側が作ったものをそのまま出す。 */
export function buildRwfResultPanel(input: {
  action: WorkflowAction;
  ok: boolean;
  text: string;
}): RenderedPanel {
  const rwf = getRwf();
  const help = rwf.WORKFLOW_ACTION_HELP[input.action];
  return buildPanel({
    title: `${input.ok ? "✅" : "⚠️"} ${help?.label ?? input.action}`,
    description: input.text,
    tone: input.ok ? "success" : "warning",
  });
}
