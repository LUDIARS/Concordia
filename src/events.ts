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
