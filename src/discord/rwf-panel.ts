/**
 * リアクションワークフローの操作面 (受付 / 結果 / アクション選択) — Discord。
 *
 * 描画は `interaction-ui.ts` の `buildPanel` に一本化する。 RWF の受付・結果は
 * これまで素の文字列返信だったが、 W4 で PR 操作面と同じ embed + select + button に
 * 揃える。 アクションの語彙・説明は RWF エンジン (`WORKFLOW_ACTION_HELP`) が正本で、
 * ここは表示への写像だけを持つ。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W4
 */

import type { WorkflowAction } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import {
  buildPanel,
  decodePanelId,
  encodePanelId,
  type PanelSelectOption,
  type RenderedPanel,
} from "./interaction-ui.js";

/** RWF 操作面の customId 名前空間。 */
export const RWF_PANEL_NAMESPACE = "rwf";

export type RwfPanelAction = "choose" | "actions" | "pr-panel";

const RWF_PANEL_ACTIONS: readonly RwfPanelAction[] = ["choose", "actions", "pr-panel"];

export function buildRwfPanelId(action: RwfPanelAction, targetMessageId: string): string {
  return encodePanelId(RWF_PANEL_NAMESPACE, action, targetMessageId);
}

export function parseRwfPanelId(
  customId: string,
): { action: RwfPanelAction; targetMessageId: string } | null {
  const decoded = decodePanelId(customId, RWF_PANEL_NAMESPACE);
  if (!decoded) return null;
  const action = decoded.action as RwfPanelAction;
  if (!RWF_PANEL_ACTIONS.includes(action)) return null;
  const targetMessageId = decoded.params[0] ?? "";
  if (!targetMessageId) return null;
  return { action, targetMessageId };
}

/** 発火を受け付けた直後に出す面。 ここから別アクションや PR 操作へ移れる。 */
export function buildRwfAckPanel(input: {
  action: WorkflowAction;
  emoji: string;
  targetMessageId: string;
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
    buttons: [
      {
        customId: buildRwfPanelId("actions", input.targetMessageId),
        label: "他のアクションを選ぶ",
        style: "secondary",
        emoji: "🧭",
      },
      {
        customId: buildRwfPanelId("pr-panel", input.targetMessageId),
        label: "PR 操作パネル",
        style: "secondary",
        emoji: "📮",
      },
    ],
  });
}

/** 実行結果の面。 成否で色を変えるだけで、 文言はワークフロー側が作ったものをそのまま出す。 */
export function buildRwfResultPanel(input: {
  action: WorkflowAction;
  ok: boolean;
  text: string;
  targetMessageId: string;
}): RenderedPanel {
  const rwf = getRwf();
  const help = rwf.WORKFLOW_ACTION_HELP[input.action];
  return buildPanel({
    title: `${input.ok ? "✅" : "⚠️"} ${help?.label ?? input.action}`,
    description: input.text,
    tone: input.ok ? "success" : "warning",
    buttons: [
      {
        customId: buildRwfPanelId("actions", input.targetMessageId),
        label: "他のアクションを選ぶ",
        style: "secondary",
        emoji: "🧭",
      },
    ],
  });
}

/**
 * アクション選択の面。 絵文字を覚えていなくても同じワークフローを起こせるようにする
 * (選択後は絵文字リアクションと同じ経路を通るので、 権限判定も dedupe も共通)。
 */
export function buildRwfActionSelectPanel(input: {
  targetMessageId: string;
  /** 出す候補。 未指定なら RWF エンジンが持つ全アクション。 */
  actions?: readonly WorkflowAction[];
}): RenderedPanel {
  const rwf = getRwf();
  const actions = input.actions ?? rwf.WORKFLOW_ACTIONS;
  return buildPanel({
    title: "🧭 リアクションワークフローを選ぶ",
    description: "このメッセージを対象に実行するワークフローを選びます。絵文字リアクションと同じ処理が走ります。",
    tone: "info",
    selects: [
      {
        customId: buildRwfPanelId("choose", input.targetMessageId),
        placeholder: "実行するワークフロー",
        options: actions.map((action) => toActionOption(rwf, action)),
      },
    ],
    buttons: [
      {
        customId: buildRwfPanelId("pr-panel", input.targetMessageId),
        label: "PR 操作パネル",
        style: "secondary",
        emoji: "📮",
      },
    ],
  });
}

function toActionOption(rwf: ReturnType<typeof getRwf>, action: WorkflowAction): PanelSelectOption {
  const help = rwf.WORKFLOW_ACTION_HELP[action];
  const emoji = rwf.primaryEmojiForAction(action);
  return {
    value: action,
    label: help?.label ?? action,
    description: help?.summary,
    ...(emoji ? { emoji } : {}),
  };
}
