import type { DelegationRunRow } from "../db/delegation-repo.js";

export type DelegationStatus = "running" | "completed" | "partial" | "failed";

export interface DelegationStatusPayload {
  status: DelegationStatus;
  detail?: string;
  result?: string;
  remaining?: Array<{ title: string; note?: string; scope_dirs?: string[] }>;
  acceptance_report?: Array<{ criterion: string; met: boolean; note?: string }>;
}

export function normalizeDelegationStatus(value: unknown): DelegationStatus | null {
  return value === "running" || value === "completed" || value === "partial" || value === "failed" ? value : null;
}

export function resolveDelegationRunIdForSession(input: {
  metadataRunId?: unknown;
  pendingRunId?: string | null;
}): string | null {
  if (typeof input.metadataRunId === "string" && input.metadataRunId.trim()) {
    return input.metadataRunId.trim();
  }
  return input.pendingRunId?.trim() || null;
}

export function buildDelegationStatusNotification(
  run: Pick<DelegationRunRow, "id" | "call_name" | "child_session_id">,
  payload: DelegationStatusPayload,
): string {
  const title = payload.status === "completed"
    ? "Delegation completed"
    : payload.status === "partial"
      ? "Delegation partial — continuation scheduled"
    : payload.status === "failed"
      ? "Delegation failed"
      : "Delegation running";
  const lines = [
    `${title}: ${run.call_name}`,
    `run_id: ${run.id}`,
  ];
  if (run.child_session_id) lines.push(`child_session_id: ${run.child_session_id}`);
  if (payload.detail?.trim()) lines.push(`detail: ${payload.detail.trim()}`);
  if (payload.result?.trim()) lines.push(`result: ${payload.result.trim()}`);
  if (payload.remaining?.length) lines.push(`remaining: ${payload.remaining.map((item) => item.title).join(", ")}`);
  const unmet = payload.acceptance_report?.filter((item) => !item.met) ?? [];
  if (unmet.length) lines.push(`unmet acceptance: ${unmet.map((item) => item.criterion).join(", ")}`);
  return lines.join("\n");
}

export function buildDelegationInjectText(input: {
  runId: string;
  text: string;
}): string {
  return [
    `[delegation:${input.runId}] Parent instruction`,
    "",
    input.text.trim(),
  ].join("\n");
}

/** 猶予の既定値 (秒)。 設定画面の表示既定と実行時の既定を 1 箇所に持つ。 */
export const DEFAULT_PARENT_QUESTION_ESCALATION_SEC = 300;

/**
 * 親 (委託元) が質問を裁くまでの猶予 (秒)。 これを過ぎた質問は人間へ自動で上げる。
 *
 * 委託が無言で止まる状態を作らないための保険。 親セッションが落ちている / 別作業で
 * 手が離せない / そもそもリレーを読んでいない、 のいずれでも子は待ち続けてしまう。
 * env `CONCORDIA_PARENT_QUESTION_ESCALATION_SEC` で上書き。
 *
 * `0` 以下は「自動エスカレーション無効」の**有効な設定値**なので、 `|| default` で
 * 潰さない (潰すと設定画面が案内する無効化手段が効かない)。 数値として読めない値
 * だけを既定へ落とす。
 */
export const PARENT_QUESTION_ESCALATION_SEC = (() => {
  const raw = process.env.CONCORDIA_PARENT_QUESTION_ESCALATION_SEC;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PARENT_QUESTION_ESCALATION_SEC;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PARENT_QUESTION_ESCALATION_SEC;
})();

/**
 * 委託子セッションの Question を親 (委託元) セッションへリレーする本文。
 * 親は自分で判断して answer-question API で回答するか、 escalate-question API で
 * 人間へ上げる (ask マーカーで聞き直すと子の質問と回答が結び付かない)。
 *
 * @implements SPEC-DELEGATION-QUESTION-PARENT-FIRST
 */
export function buildDelegationQuestionRelayText(input: {
  runId: string;
  childSessionId: string;
  questionId: number;
  question: string;
  options: readonly string[];
}): string {
  return [
    `[delegation:${input.runId}] 子セッション ${input.childSessionId} からの質問`,
    "",
    input.question.trim(),
    "",
    ...input.options.map((label, i) => `${i}. ${label}`),
    "",
    "この質問は **あなただけ** に届いています (人間にはまだ出していません)。",
    "委託元として回答してください:",
    `POST /v1/sessions/${input.childSessionId}/answer-question`,
    `body: {"question_id":${input.questionId},"answer_index":<番号>} または {"question_id":${input.questionId},"other_text":"..."}`,
    "",
    "自分で判断できないときは、 ask マーカーで人間に聞くのではなく **この API で人間へ上げてください**",
    "(そうしないと子セッションの質問と人間の回答が結び付きません):",
    `POST /v1/sessions/${input.childSessionId}/escalate-question`,
    `body: {"question_id":${input.questionId},"note":"何が判断できないか"}`,
    // 自動エスカレーションが無効なら「待てば上がる」と書かない。 書くと親が放置を
    // 選び、 子が永久に待つ (無効化は運用上ありうる設定なので文面を分ける)。
    PARENT_QUESTION_ESCALATION_SEC > 0
      ? `一定時間 (既定 ${Math.round(PARENT_QUESTION_ESCALATION_SEC / 60)} 分) 応答が無ければ自動で人間へ上がります。`
      : "自動エスカレーションは無効です。 放置すると子セッションは待ち続けるので、 必ずどちらかを行ってください。",
  ].join("\n");
}

export function buildDelegationMirrorText(input: {
  runId: string;
  childSessionId: string;
  text: string;
}): string {
  return [
    `[delegation:${input.runId}] child ${input.childSessionId}`,
    "",
    input.text.trim(),
  ].join("\n");
}
