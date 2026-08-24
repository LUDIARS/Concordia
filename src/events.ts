/**
 * Concordia event bus (in-process pub/sub).
 *
 * SSE / WS clients が購読する. dispatcher / sweeper / api handlers が emit する.
 */

import type { SessionMessagePayload } from "./shared/session-message-types.js";
import type { TeamCardEventKind } from "./shared/team-cards.js";
export type { SessionMessagePayload } from "./shared/session-message-types.js";

/**
 * `session.message` の wire payload。 `session_messages` 行のシリアライズ表現
 * (events.ts は db/ 層に依存できないため独立定義 — 循環 import 回避)。
 */
type ConcordiaEventPayload =
  | { type: "session.started";  session_id: string; provider: string; repo_path: string; branch: string | null; ts: number }
  | { type: "session.lost";     session_id: string; ts: number }
  | { type: "session.ended";    session_id: string; ts: number }
  | { type: "session.event";    session_id: string; kind: string; ts: number }
  | { type: "session.task_changed"; session_id: string; previous_task: string | null; current_task: string | null; ts: number }
  | { type: "chat.posted";      message_id: number; channel: string; author_label: string; ts: number; is_actionable: boolean; scope?: "world" | "local"; session_id?: string | null }
  | { type: "task.enqueued";    session_id: string; task_id: number; kind: string; ts: number }
  | {
      type: "operational.claim.opened";
      target_session_id: string;
      claim_kind: string;
      claim_id: number;
      resource: string;
      branch: string | null;
      note: string;
      conflict_session_ids: string[];
      started_at: number;
      ts: number;
    }
  | {
      type: "operational.claim.released";
      target_session_id: string;
      claim_kind: string;
      claim_id: number;
      resource: string;
      branch: string | null;
      note: string;
      started_at: number;
      ts: number;
    }
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
      parent_session_id?: string | null;
      child_session_id: string | null;
      link_side?: "parent" | "child";
      text: string;
      ts: number;
    }
  | {
      type: "delegation.run_changed";
      parent_session_id: string;
      run_id: string;
      status: string;
      ts: number;
    }
  | {
      type: "taskflow.user_decision";
      kind: "confirm-queued" | "no-tasks" | "pr-decision" | "impl-unlock" | "question";
      target_session_id: string;
      text: string;
      mention_user_id: string | null;
      ts: number;
    }
  | { type: "taskflow.completion_detected"; session_id: string; pr_number: number | null; outcome: string; decision_id?: number; ts: number }
  | { type: "taskflow.residual_checked"; session_id: string; outcome: "next-task" | "decompose" | "none"; pending_count: number; ts: number }
  | { type: "taskflow.continue_requested"; target_session_id: string; text: string; ts: number }
  | { type: "director.plan_submitted"; target_session_id: string; case_id: string; version: number; markdown: string; ts: number }
  | { type: "team.created"; event_id: string; team_id: string; name: string; slug: string; ts: number }
  | { type: "team.changed"; event_id: string; team_id: string; fields: string[]; ts: number }
  /**
   * チーム面へ載せる本文付きカード。standup / meeting は朝礼・定例 delegation の報告、
   * task-kanban はタスク整理の報告 (いずれも POST /v1/teams/:id/cards、
   * spec/feature/director-workflow.md §2)。question は Director 巡回の人間エスカレーション
   * (spec/feature/director-patrol.md §1.4、Cc 内部からの emit のみ)。
   */
  | { type: "team.card_requested"; team_id: string; kind: TeamCardEventKind; title: string; body: string; ts: number }
  | { type: "vibes.ok"; session_id: string; source: string; ts: number }
  | { type: "inquiry.resolved"; target_session_id: string; category: string; decision: "proceed" | "ask_human" | "self_judge"; supervisor_user_id: string | null; ts: number }
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
   * 停滞セッションへ自動確認 (stall nudge) を注入した事実の通知。inject 本文は
   * 含めない (Discord へは「送った」ことだけを短文で知らせる — 2026-08-25 neco 指示)。
   * メンション先の個人識別子は WS へ流さず、Discord bot の配信境界で解決する。
   */
  | { type: "session.stall_nudged"; target_session_id: string; idle_sec: number; ts: number }
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
      /** 委託子セッションの質問のとき、 親 (委託元) セッション。 Discord の面フォールバック先。 */
      parent_session_id?: string;
      /** 同上。 リレー通知の [delegation:<id>] 前置に使う。 */
      delegation_run_id?: string;
      /** この質問の起因者 (直近で指示した人間)。 Discord は @メンションに使う。未取得は省略。 */
      requester_platform?: "discord" | "slack";
      requester_user_id?: string;
      ts: number;
    }
  | { type: "question.answered"; target_session_id: string; question_id: number; answer_index: number; answer_text: string; ts: number }
  // picker がローカル回答で解決し、リモート回答なしに失効した（Lictor 通知）。
  // Discord/Slack 側はボタン除去に使い、古いボタンの再クリックを防ぐ。
  | { type: "question.resolved"; target_session_id: string; question_id: number; ts: number }
  /**
   * `session_messages` への projector 出力 1 件 (spec/feature/session-message-layer.md §4)。
   * Discord egress (D6) / WebUI (D4) が transcript.frame の代わりにこれを購読して描画する
   * 正本イベント。 `message` は `session_messages` 行そのもの (id 込み)。
   */
  | { type: "session.message"; target_session_id: string; op: "create" | "update"; message: SessionMessagePayload; ts: number }
  /**
   * 未読バッジ更新用の軽量シグナル (全 client へ)。 実際の未読件数は
   * `GET /v1/sessions/:id/messages/unread?client_id=` を client が引き直す。
   */
  | { type: "session.message.summary"; target_session_id: string; latest_id: number; ts: number }
  /**
   * 連合リンク (マルチ拠点) の拠点接続状態変化. 本社側 listener が emit し、
   * WebUI の子会社一覧が再取得トリガに使う.
   */
  | { type: "federation.site.connected";    site_id: string; ts: number }
  | { type: "federation.site.disconnected"; site_id: string; ts: number }
  | { type: "ping";             ts: number };

type ChatEventType =
  | "chat.posted"
  | "operational.claim.opened"
  | "operational.claim.released"
  | "session.inject"
  | "transcript.frame"
  | "session.permission_request"
  | "delegation.mirror"
  | "taskflow.user_decision"
  | "taskflow.continue_requested"
  | "question.posted"
  | "question.answered"
  | "question.resolved";

type CostEventType = "stat.collected";

export type ChatEvent = Extract<ConcordiaEventPayload, { type: ChatEventType }>;
export type CostEvent = Extract<ConcordiaEventPayload, { type: CostEventType }>;
export type CoreEvent = Exclude<ConcordiaEventPayload, ChatEvent | CostEvent>;
export type ConcordiaEvent = CoreEvent | ChatEvent | CostEvent;

/** Returns the session targeted by an event, when it has one. */
export function eventSessionId(event: ConcordiaEvent): string | null {
  switch (event.type) {
    case "session.started":
    case "session.lost":
    case "session.ended":
    case "session.event":
    case "session.task_changed":
      return event.session_id;
    case "transcript.frame":
    case "session.inject":
    case "session.stall_nudged":
    case "session.permission_request":
    case "delegation.mirror":
    case "question.posted":
    case "question.answered":
    case "question.resolved":
    case "operational.claim.opened":
    case "operational.claim.released":
    case "session.message":
    case "session.message.summary":
      return event.target_session_id;
    case "chat.posted":
      return event.session_id ?? null;
    default:
      return null;
  }
}

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
