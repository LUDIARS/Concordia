/** Fixed user-facing guidance only; never render arbitrary server exception text. @implements CC-TF-ERROR-01 */
const GUIDANCE: Readonly<Record<string, string>> = {
  actio_unavailable: 'タスク管理サービス（Actio）に接続できません。Excubitorで稼働状態を確認してください。',
  actio_configuration_invalid: 'Actioへの接続設定・認証設定を確認してください。',
  actio_binding_invalid: 'この作業とActioのプロジェクト・組織の対応を確認してください。',
  actio_project_ambiguous: 'Actioの対象プロジェクト・チームを一つに特定できません。登録内容を確認してください。',
  actio_team_invalid: '選択したチームがプロジェクトに登録されているか確認してください。',
  actio_scope_denied: '対象を読む権限を確認できません。所有者・組織・認証設定を確認してください。',
  actio_response_invalid: 'Actioから想定と異なる応答が返りました。サービスの版と診断ログを確認してください。',
  actio_request_rejected: 'Actioが要求を受け付けませんでした。権限と診断ログを確認してください。',
  actio_outcome_unknown: 'Actioの処理結果を確認できません。同じ操作を送り直す前に、元の依頼の状態を確認してください。',
  revisor_lookup_unavailable: '審査サービス（Revisor）の状態を取得できません。審査が存在しないとは判断せず、稼働状態を確認してください。',
  task_repository_unresolved: '作業対象のリポジトリを特定できません。登録内容を確認してください。',
  task_identity_conflict: '同じ依頼IDに異なる内容が指定されています。元の依頼を確認してください。',
  task_execution_conflict: 'このタスクには実行中の処理があります。新しく実行せず、その状態を確認してください。',
  task_worker_conflict: 'タスクの担当が変わりました。現在の担当を確認してください。',
  task_migration_required: '旧形式のタスク参照です。Actioへの移行状況を確認してください。',
  task_reference_invalid: '対象のActioタスクを指定してください。',
  taskflow_internal_error: 'タスクワークフロー内部でエラーが起きました。発生時刻とコードを手がかりに、Ccの診断ログを確認してください。',
  taskflow_connection_failed: 'Ccに接続できません。接続と稼働状態を確認してから、表示を更新してください。',
  taskflow_request_failed: 'タスク情報を取得できませんでした。接続・権限とCcの診断ログを確認してください。',
};

export function safeFailureReason(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(GUIDANCE, value) ? value : 'taskflow_request_failed';
}

export function failureGuidance(reason: unknown): string {
  return GUIDANCE[safeFailureReason(reason)];
}

export class TaskflowLoadError extends Error {
  constructor(readonly reason: string, readonly status?: number) {
    super(failureGuidance(reason));
  }
}

/** Read-only refresh, with bounded, allowlisted error information. @implements CC-TF-ERROR-01 */
export async function getTaskflowOverview<T>(path: string): Promise<T> {
  let response: Response;
  try { response = await fetch(path); }
  catch { throw new TaskflowLoadError('taskflow_connection_failed'); }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const reason = body && typeof body === 'object' && 'reason' in body ? body.reason : undefined;
    throw new TaskflowLoadError(safeFailureReason(reason), response.status);
  }
  try { return await response.json() as T; }
  catch { throw new TaskflowLoadError('taskflow_request_failed', response.status); }
}
