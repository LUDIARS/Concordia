/**
 * Concordia event bus (in-process pub/sub).
 *
 * SSE / WS clients が購読する. dispatcher / sweeper / api handlers が emit する.
 */

type ConcordiaEventPayload =
  | { type: "session.started";  session_id: string; provider: string; repo_path: string; branch: string | null; ts: number }
  | { type: "session.lost";     session_id: string; ts: number }
  | { type: "session.ended";    session_id: string; ts: number }
  | { type: "session.event";    session_id: string; kind: string; ts: number }
  | { type: "chat.posted";      message_id: number; channel: string; author_label: string; ts: number; is_actionable: boolean; scope?: "world" | "local"; session_id?: string | null }
  | { type: "task.enqueued";    session_id: string; task_id: number; kind: string; ts: number }
  | { type: "skill.snapshot";   skill_name: string; repo_path: string; poison_score: number; growth_score: number; ts: number }
  | { type: "report.generated"; session_id: string; ts: number }
  | { type: "rule.changed";     rule_id: string | null; action: "add" | "remove" | "toggle" | "fire" | "skip" | "error"; ts: number }
  | {
      type: "delegation.templates_changed";
      action: "create" | "import" | "duplicate" | "patch" | "delete";
      template_id: string | null;
      call_name: string | null;
      ts: number;
    }
  | {
      type: "delegation.mirror";
      target_session_id: string;
      run_id: string;
      child_session_id: string | null;
      text: string;
      ts: number;
    }
  | { type: "persona.assigned"; session_id: string; persona_id: string; persona_name: string; ts: number }
  | { type: "persona.released"; session_id: string; persona_id: string; ts: number }
  | { type: "persona.feedback"; persona_id: string; session_id: string | null; kind: string; ts: number }
  | { type: "process.started";  process_name: string; pid: number; cwd: string; command: string; ts: number }
  | { type: "process.log";      process_name: string; stream: "stdout" | "stderr" | "event"; line: string; level?: "error" | "warn" | "info"; ts: number }
  | { type: "process.exited";   process_name: string; exit_code: number | null; signal: string | null; ts: number }
  | { type: "stat.collected";   session_id: string; stat_id: number; ts: number }
  /**
   * PR キューが変化した (新規 PR 取り込み or reconcile での状態遷移). Discord の
   * pr-queue チャンネル / WS subscriber が再描画するトリガ. 個別 PR の id は持たず、
   * 受け手は GET /v1/prs を引き直す (キューは小さいので全更新で十分).
   */
  | { type: "pr.changed";       reason: "ingest" | "reconcile" | "full-sync"; ts: number }
  /**
   * 監視ロガーが検知したエラー or Concordia 内部 (Discord 操作等) の失敗.
   * Discord bot が「エラー」 カテゴリの errors チャンネルへ転記する.
   * `source` は発生源ラベル (例 "discord", "vestigium:<service>").
   */
  | { type: "error.reported";   source: string; message: string; detail?: Record<string, unknown>; ts: number }
  /**
   * Instruction pushed at a specific session over its WS. Lictor (or any other
   * WS subscriber with the matching session_id) injects the text into the
   * wrapped TUI as user-typed input. Filtered by WS broadcaster — only
   * clients whose ?session=<id> matches `target_session_id` receive it.
   * `source` is an optional human-readable label (e.g. another role / a script
   * name) for telemetry; not a security boundary.
   */
  // author_label: 人間入力者の表示名 (発言者明示のクロスプラットフォーム・ミラー用)。
  // source が "discord:<uid>:…" / "slack:<uid>:…" の人間メッセージのときに付く。
  | { type: "session.inject";   target_session_id: string; text: string; source: string | null; author_label?: string | null; ts: number }
  /**
   * One frame from a session's transcript stream. Lictor tails Claude's
   * JSONL session file and POSTs each line (after simplification) as a
   * frame. Forwarded via WS so the Web UI's transcript pane can render
   * live. `kind` is the envelope type (`text` / `tool-use` / `tool-result`
   * / `thinking` / `system` / `meta`); `payload` is opaque (depends on
   * kind). `seq` is per-session monotonic so clients can detect gaps.
   *
   * Session-targeted: only clients with matching `?session=<id>` receive
   * the frame (same WS filter as session.inject).
   */
  | { type: "transcript.frame"; target_session_id: string; seq: number; kind: string; payload: unknown; ts: number }
  /**
   * Tool permission request — Lictor's PreToolUse hook fired and is blocking
   * the wrapped Claude session until the user approves/denies via Web UI.
   * Session-targeted so only clients viewing this session receive it.
   * `tool_input` is a slim preview (kept compact for wire / UI).
   */
  | {
      type: "session.permission_request";
      target_session_id: string;
      request_id: string;
      tool_name: string;
      tool_input: unknown;
      requester_platform?: "discord" | "slack";
      requester_user_id?: string;
      ts: number;
    }
  | {
      type: "question.posted";
      target_session_id: string;
      question_id: number;
      question: string;
      /**
       * 旧形式 `string[]` も新形式 `{label, description?}[]` も来うる. consumer は両方扱える前提.
       * (Lictor 経由で来た option は API レイヤで {label, description?} に正規化済み)
       */
      options: Array<string | { label: string; description?: string }>;
      /** 複数選択可か (Discord UI を menu(min1/maxN) に切替)。未指定は単一選択。 */
      multi_select?: boolean;
      /** この質問の起因者 (直近で指示した人間)。 Discord は @メンションに使う。未取得は省略。 */
      requester_platform?: "discord" | "slack";
      requester_user_id?: string;
      ts: number;
    }
  | { type: "question.answered"; target_session_id: string; question_id: number; answer_index: number; answer_text: string; ts: number }
  // picker がローカル回答で解決し、リモート回答なしに失効した（Lictor 通知）。
  // Discord/Slack 側はボタン除去に使い、古いボタンの再クリックを防ぐ。
  | { type: "question.resolved"; target_session_id: string; question_id: number; ts: number }
  | { type: "ping";             ts: number };

type ChatEventType =
  | "chat.posted"
  | "session.inject"
  | "transcript.frame"
  | "session.permission_request"
  | "delegation.mirror"
  | "question.posted"
  | "question.answered"
  | "question.resolved";

type CostEventType = "stat.collected";

export type ChatEvent = Extract<ConcordiaEventPayload, { type: ChatEventType }>;
export type CostEvent = Extract<ConcordiaEventPayload, { type: CostEventType }>;
export type CoreEvent = Exclude<ConcordiaEventPayload, ChatEvent | CostEvent>;
export type ConcordiaEvent = CoreEvent | ChatEvent | CostEvent;

type Listener = (ev: ConcordiaEvent) => void;

class EventBus {
  private listeners = new Set<Listener>();

  emit(ev: ConcordiaEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* swallow */ }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

export const eventBus = new EventBus();
