import { fmtTs } from '../../api.js';
import { failureGuidance, safeFailureReason } from '../../lib/taskflow-failure.js';

const OPERATIONS: Readonly<Record<string, string>> = {
  'interactive-completion': '作業完了の判定',
  'revisor-notice': '審査結果を受け取った後の処理',
  'session-assignment': 'タスク担当の更新',
};

/** Latest persisted evidence, not an active incident or recovery claim. @implements CC-TF-ERROR-01 */
export function TaskflowFailurePanel({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.observed_at !== 'number' || !Number.isFinite(item.observed_at)) return null;
  const operation = typeof item.operation === 'string' && Object.hasOwn(OPERATIONS, item.operation)
    ? OPERATIONS[item.operation] : 'タスクワークフローの処理';
  const reason = safeFailureReason(item.reason);
  return <section aria-label="タスクワークフローのエラー" className="rounded border border-danger bg-danger/10 p-3 text-sm">
    <h2 className="font-semibold">直近のタスクワークフローエラー</h2>
    <p>{fmtTs(item.observed_at)} · {operation}</p>
    <p>{failureGuidance(reason)}</p>
    <p className="text-xs">確認コード: {reason}</p>
    <p>発生時の記録です。解消したかどうかは未確認です。表示の更新で処理を再実行することはありません。</p>
  </section>;
}
