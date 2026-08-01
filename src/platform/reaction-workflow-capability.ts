/**
 * リアクションワークフローの各アクションが要求する権限 (純粋な対応表)。
 *
 * リアクションそのものは**指示の簡略化**であって権限ではない (neco 2026-08-01)。
 * 絵文字は誰でも押せる。 ただし「指示の内容が実行できるとは限らない」 — 中身が
 * セッション起動やマージのような破壊的操作なら、 そこで改めて役職が問われる。
 *
 * ここに載らないアクションは AI への作業指示 (洗い出し・記録・状況報告など) で、
 * 追加の権限を要らない。
 */

import { CAPABILITY_LABEL, CAPABILITY_MIN_ROLE, STAFF_ROLE_LABEL } from "../staff/roles.js";
import type { StaffCapability } from "../staff/roles.js";
import type { WorkflowAction } from "./reaction-workflow-action.js";

/** アクション → 追加で要求する権限。 未掲載は権限不要。 */
const ACTION_CAPABILITY: Partial<Record<WorkflowAction, StaffCapability>> = {
  // 🤝 は delegation invoke = 別セッションを起動する。
  "delegate-task": "session_spawn",
  // 🔀 / 🚀 は PR を実際に着地させる。
  "merge-pr": "merge_pr",
  // 🔄 はマージ後に main を書き換える (マージと同じ重さ)。
  "sync-project-main-after-merge": "merge_pr",
  // 🛠️ は「指示」ではなく設定の永続化 — 任意プロンプトを絵文字に束ねて JSON に保存する。
  // カスタムワークフローは handle() の写像照合が空振りした側の分岐で走る = ここの権限判定を
  // 通らないので、 登録を開けると「マージせよ」というプロンプトを登録して押す、という抜け道になる。
  // 登録側を管理職以上に閉じてこの経路を塞ぐ (発火そのものは従来どおり誰でも可)。
  "add-as-workflow": "session_spawn",
};

export function workflowActionCapability(action: WorkflowAction): StaffCapability | null {
  return ACTION_CAPABILITY[action] ?? null;
}

/**
 * 拒否文言で使う権限の短い呼び名。 未掲載は名簿の表示名 (CAPABILITY_LABEL) に落ちるので、
 * 対応表に新しい capability を足しても文言が別の権限を名乗ることはない。
 */
const NEED_LABEL: Partial<Record<StaffCapability, string>> = {
  merge_pr: "マージ",
  session_spawn: "セッション起動",
};

/** 拒否時に本人へ返す文言。 何が足りないかを名指しする (黙って無視しない)。 */
export function workflowDenialMessage(action: WorkflowAction, capability: StaffCapability): string {
  const need = NEED_LABEL[capability] ?? CAPABILITY_LABEL[capability];
  // 要求役職も名簿の正本から引く (roles.ts を変えたら文言も追随する)。
  const role = STAFF_ROLE_LABEL[CAPABILITY_MIN_ROLE[capability]];
  return `この操作 (${action}) には${need}権限が必要です。社員名簿で${role}以上の役職が要ります。`;
}
