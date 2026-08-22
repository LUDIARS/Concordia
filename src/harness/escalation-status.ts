/**
 * ハーネス状態カードのエスカレーション表示 (spec/feature/escalation-mode.md §1).
 *
 * 「今このセッションは規律を外している」 が状態カードから読めないと、 外したことに
 * 誰も気づけないまま期間だけが伸びる。 表示はモードの抑止力そのもの。
 *
 * 純関数のみ (描画先に依存しない)。 Discord embed 側はこの文字列を差すだけにする。
 */

export interface EscalationStatus {
  active: boolean;
  reason: string | null;
  started_at: number | null;
}

/** カード先頭に出す短いバッジ。 非エスカレーション時は null。 */
export function formatEscalationBadge(status: EscalationStatus | null | undefined): string | null {
  if (!status?.active) return null;
  return "🚨 エスカレーション中 (通常ワークフロー停止)";
}

/**
 * カードの本文欄。 理由と経過時間を出す — 「いつからか」 が無いと、 解除し忘れが
 * 通常運転に見えてしまう。
 */
export function formatEscalationField(
  status: EscalationStatus | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!status?.active) return null;
  const reason = status.reason?.trim() || "(理由未記録)";
  const elapsed = status.started_at != null ? formatElapsed(Math.max(0, now - status.started_at)) : null;
  const head = elapsed ? `理由: ${truncate(reason, 400)} (${elapsed}経過)` : `理由: ${truncate(reason, 400)}`;
  return [
    head,
    "task 登録と worktree 分離は外れています。 GitHub 直 push / GitHub PR・マージ、 他セッションの変更の破棄は外れません。",
  ].join("\n");
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}時間` : `${Math.floor(hours / 24)}日`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
