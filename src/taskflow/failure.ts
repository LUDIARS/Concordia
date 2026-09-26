/** Safe boundary diagnostics. Never expose arbitrary exception text or causes. */
export interface TaskflowFailureDescription {
  code: string;
  status: 400 | 403 | 409 | 500 | 502 | 503;
  message: string;
}

export class RevisorLookupUnavailable extends Error {
  constructor() { super("Revisor local PR lookup unavailable"); }
}

const known: ReadonlyMap<string, TaskflowFailureDescription> = new Map([
  ...[
    "CONCORDIA_ACTIO_TASK_BINDINGS is required and must be JSON",
    "Invalid CONCORDIA_ACTIO_TASK_BINDINGS",
    "Actio binding repoPath must be absolute",
    "Subsidiary Actio binding requires teamId",
    "Duplicate Actio project ownership binding",
    "Invalid Actio authentication binding",
    "Actio task credential is required",
  ].map((message): [string, TaskflowFailureDescription] => [message, {
    code: "actio_configuration_invalid", status: 503, message: "Actio の接続設定・認証設定を確認してください。",
  }]),
  ["Actio task project binding missing or ambiguous", {
    code: "actio_binding_invalid", status: 503, message: "作業リポジトリのプロジェクトコードと Actio の登録・組織範囲を確認してください。",
  }],
  ["Actio project registration is ambiguous", {
    code: "actio_project_ambiguous", status: 503, message: "Actio のプロジェクト登録を一意に特定できません。",
  }],
  ["Invalid Actio project list response", {
    code: "actio_response_invalid", status: 502, message: "Actio のプロジェクト一覧が契約と一致しません。",
  }],
  ["Task repository identity could not be resolved", {
    code: "task_repository_unresolved", status: 503, message: "作業リポジトリを特定できません。Git の登録を確認してください。",
  }],
  ["Actio task service unavailable", {
    code: "actio_unavailable", status: 503, message: "Actio の稼働状態を確認してください。",
  }],
  ...["Actio task identity mismatch", "Actio task authentication mode mismatch", "Actio task ownership mismatch"]
    .map((message): [string, TaskflowFailureDescription] => [message, {
      code: "actio_scope_denied", status: 403, message: "Actio の所有者・組織・認証方式が対象と一致しません。",
    }]),
  ...["Invalid Actio task list response", "Invalid Actio task response", "Actio source identity mismatch"]
    .map((message): [string, TaskflowFailureDescription] => [message, {
      code: "actio_response_invalid", status: 502, message: "Actio の応答がタスクの契約と一致しません。",
    }]),
  ["Actio task request identity reused with different content", {
    code: "task_identity_conflict", status: 409, message: "同じ依頼 ID に異なる内容が指定されています。元の依頼を確認してください。",
  }],
  ["Actio task already associated with a delegation; inspect that run before retry", {
    code: "task_execution_conflict", status: 409, message: "タスクは既存の実行に関連付いています。その実行を確認してください。",
  }],
  ["Legacy task file references require explicit Actio migration", {
    code: "task_migration_required", status: 409, message: "旧タスク参照には明示的な Actio 移行が必要です。",
  }],
  ["Actio task reference required", {
    code: "task_reference_invalid", status: 400, message: "Actio タスク参照を指定してください。",
  }],
  ["Actio task request outcome unknown; reconcile using the same task identity", {
    code: "actio_outcome_unknown", status: 503, message: "Actio の処理結果が不明です。同じ依頼 ID で結果を照合してください。",
  }],
]);

export function describeTaskflowFailure(error: unknown): TaskflowFailureDescription {
  if (error instanceof Error && error.message === "Task working session changed") {
    return { code: "task_worker_conflict", status: 409, message: "タスクの担当が変わりました。現在の担当を確認してください。" };
  }
  if (error instanceof Error && error.message === "Invalid Actio session metadata") {
    return { code: "actio_response_invalid", status: 502, message: "タスクのセッション情報が契約と一致しません。" };
  }
  if (error instanceof RevisorLookupUnavailable) {
    return { code: "revisor_lookup_unavailable", status: 503,
      message: "Revisor の PR 状態を取得できません。PR 不在とは判定せず、復旧後に再確認してください。" };
  }
  if (error instanceof Error) {
    const description = known.get(error.message);
    if (description) return description;
    if (/^Actio task request rejected \(\d{3}\)$/.test(error.message)) {
      return { code: "actio_request_rejected", status: 502,
        message: "Actio が要求を拒否しました。接続先の API 契約と権限を確認してください。" };
    }
  }
  return { code: "taskflow_internal_error", status: 500,
    message: "タスクワークフロー内部でエラーが発生しました。診断ログを確認してください。" };
}
