/**
 * PR 提出 / マージの操作面 (Discord)。
 *
 * 描画は `interaction-ui.ts` の `buildPanel` に一本化し、 ここは「何を出すか」だけを
 * 宣言する (embed / ActionRow を自前で組まない = 見た目の二重管理を作らない)。
 * 結果の文言は RWF と同じ `reaction-workflow-pr.ts` の describe* を使うので、
 * 絵文字リアクション経由でもボタン経由でも同じ言い回しになる。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W2 / W4
 */

import type {
  RwfLocalPrRef,
  RwfPrActor,
  RwfPrMergeOutcome,
  RwfPrSubmitOutcome,
} from "../platform/reaction-workflow-pr.js";
import {
  describePrMergeOutcome,
  describePrSubmitOutcome,
} from "../platform/reaction-workflow-pr.js";
import {
  buildPanel,
  decodePanelId,
  encodePanelId,
  type PanelSelectOption,
  type PanelSpec,
  type RenderedPanel,
} from "./interaction-ui.js";

/** この操作面の customId 名前空間 (`ctrl:` / `test:` とは別に切る)。 */
export const PR_PANEL_NAMESPACE = "prpanel";

export type PrPanelAction = "submit" | "merge" | "select";

const PR_PANEL_ACTIONS: readonly PrPanelAction[] = ["submit", "merge", "select"];

export function buildPrPanelId(action: PrPanelAction, sessionId: string): string {
  return encodePanelId(PR_PANEL_NAMESPACE, action, sessionId);
}

export function parsePrPanelId(customId: string): { action: PrPanelAction; sessionId: string } | null {
  const decoded = decodePanelId(customId, PR_PANEL_NAMESPACE);
  if (!decoded) return null;
  const action = decoded.action as PrPanelAction;
  if (!PR_PANEL_ACTIONS.includes(action)) return null;
  const sessionId = decoded.params[0] ?? "";
  if (!sessionId) return null;
  return { action, sessionId };
}

export interface PrPanelState {
  sessionId: string;
  /** セッションの作業ブランチ (未記録なら null)。 */
  branch: string | null;
  /** セッションの repo_origin (未記録なら null)。 */
  repository: string | null;
  /** そのリポジトリで open な local PR (選択肢に出す)。 */
  openPullRequests: readonly RwfLocalPrRef[];
  /** 直前の操作結果 (あれば embed 本文に出す)。 */
  result?: { ok: boolean; text: string };
}

/**
 * PR 操作パネル。 「今どういう状態で・何が押せるか」を 1 枚で示す。
 * 提出は破壊的でないので誰でも押せるが、 マージは `merge_pr` を持つ人だけが通る
 * (判定は実行時 — ボタンを隠して権限を推測させない)。
 */
export function buildPrOperationPanel(state: PrPanelState): RenderedPanel {
  const spec: PanelSpec = {
    title: "PR 提出 / マージ",
    description: state.result?.text ?? "Revisor の local PR を提出・マージします。",
    tone: state.result ? (state.result.ok ? "success" : "warning") : "info",
    fields: [
      { name: "リポジトリ", value: state.repository ?? "(未記録)", inline: true },
      { name: "ブランチ", value: state.branch ? `\`${state.branch}\`` : "(未記録)", inline: true },
      { name: "open な local PR", value: describeOpenPrs(state.openPullRequests), inline: false },
    ],
    selects: [
      {
        customId: buildPrPanelId("select", state.sessionId),
        placeholder: "マージする local PR を選ぶ",
        options: state.openPullRequests.map(toPrOption),
      },
    ],
    buttons: [
      {
        customId: buildPrPanelId("submit", state.sessionId),
        label: "PR を提出",
        style: "primary",
        emoji: "📮",
      },
      {
        customId: buildPrPanelId("merge", state.sessionId),
        label: "このブランチの PR をマージ",
        style: "success",
        emoji: "🔀",
      },
    ],
    footer: "マージには社員名簿の merge_pr 権限 (管理職以上) が要ります",
  };
  return buildPanel(spec);
}

/** 📮 の結果を操作パネルとして返す (次の操作をそのまま押せる形で返す)。 */
export function buildPrSubmitResultPanel(
  state: Omit<PrPanelState, "result">,
  outcome: RwfPrSubmitOutcome,
  actor: RwfPrActor,
): RenderedPanel {
  return buildPrOperationPanel({
    ...state,
    result: { ok: outcome.ok, text: describePrSubmitOutcome(outcome, actor) },
  });
}

/** 🔀 の結果を操作パネルとして返す。 */
export function buildPrMergeResultPanel(
  state: Omit<PrPanelState, "result">,
  outcome: RwfPrMergeOutcome,
  actor: RwfPrActor,
): RenderedPanel {
  return buildPrOperationPanel({
    ...state,
    result: { ok: outcome.ok, text: describePrMergeOutcome(outcome, actor) },
  });
}

function describeOpenPrs(pullRequests: readonly RwfLocalPrRef[]): string {
  if (pullRequests.length === 0) return "(なし)";
  return pullRequests.map((pr) => `#${pr.number} \`${pr.headRef}\``).join("\n");
}

function toPrOption(pr: RwfLocalPrRef): PanelSelectOption {
  return {
    value: pr.id,
    label: `#${pr.number} ${pr.headRef}`.slice(0, 100),
    description: pr.repository,
  };
}
