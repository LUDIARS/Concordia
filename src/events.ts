/**
 * Concordia event bus (in-process pub/sub).
 *
 * SSE / WS clients が購読する. dispatcher / sweeper / api handlers が emit する.
 */

export type ConcordiaEvent =
  | { type: "session.started";  session_id: string; provider: string; repo_path: string; branch: string | null; ts: number }
  | { type: "session.lost";     session_id: string; ts: number }
  | { type: "session.ended";    session_id: string; ts: number }
  | { type: "session.event";    session_id: string; kind: string; ts: number }
  | { type: "chat.posted";      message_id: number; channel: string; author_label: string; ts: number; is_actionable: boolean; scope?: "world" | "local"; session_id?: string | null }
  | { type: "task.enqueued";    session_id: string; task_id: number; kind: string; ts: number }
  | { type: "skill.snapshot";   skill_name: string; repo_path: string; poison_score: number; growth_score: number; ts: number }
  | { type: "report.generated"; session_id: string; ts: number }
  | { type: "rule.changed";     rule_id: string | null; action: "add" | "remove" | "toggle" | "fire" | "skip" | "error"; ts: number }
  | { type: "persona.assigned"; session_id: string; persona_id: string; persona_name: string; ts: number }
  | { type: "persona.released"; session_id: string; persona_id: string; ts: number }
  | { type: "persona.feedback"; persona_id: string; session_id: string | null; kind: string; ts: number }
  | { type: "process.started";  process_name: string; pid: number; cwd: string; command: string; ts: number }
  | { type: "process.log";      process_name: string; stream: "stdout" | "stderr" | "event"; line: string; level?: "error" | "warn" | "info"; ts: number }
  | { type: "process.exited";   process_name: string; exit_code: number | null; signal: string | null; ts: number }
  | { type: "stat.collected";   session_id: string; stat_id: number; ts: number }
  /**
   * Instruction pushed at a specific session over its WS. Lictor (or any other
   * WS subscriber with the matching session_id) injects the text into the
   * wrapped TUI as user-typed input. Filtered by WS broadcaster — only
   * clients whose ?session=<id> matches `target_session_id` receive it.
   * `source` is an optional human-readable label (e.g. another role / a script
   * name) for telemetry; not a security boundary.
   */
  | { type: "session.inject";   target_session_id: string; text: string; source: string | null; ts: number }
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
  | { type: "session.permission_request"; target_session_id: string; request_id: string; tool_name: string; tool_input: unknown; ts: number }
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
      ts: number;
    }
  | { type: "question.answered"; target_session_id: string; question_id: number; answer_index: number; answer_text: string; ts: number }
  | { type: "ping";             ts: number };

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
