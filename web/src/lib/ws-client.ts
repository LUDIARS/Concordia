/**
 * Concordia WebSocket client (singleton).
 *
 * バックエンドの `/ws` に接続し、 broadcast される ConcordiaEvent を listener に配信する.
 * 認証なし (loopback 想定). 接続切れは指数バックオフで自動再接続する.
 *
 * 使い方:
 *   import { wsClient } from "../lib/ws-client.js";
 *   wsClient.connect();
 *   const off = wsClient.onEvent("chat.posted", (ev) => { ... });
 *   off();
 */

type WsFrameVersion = 1;

type ConcordiaEventPayload =
  | { type: "hello"; ts: number; service: string; session_id?: string | null; registered?: boolean }
  | { type: "session.started";  session_id: string; provider: string; repo_path: string; branch: string | null; ts: number }
  | { type: "session.lost";     session_id: string; ts: number }
  | { type: "session.ended";    session_id: string; ts: number }
  | { type: "session.event";    session_id: string; kind: string; ts: number }
  | { type: "session.task_changed"; session_id: string; previous_task: string | null; current_task: string | null; ts: number }
  | { type: "session.message"; target_session_id: string; op: "create" | "update"; message: import("../api.js").SessionMessage; ts: number }
  | { type: "session.message.summary"; target_session_id: string; latest_id: number; ts: number }
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
  | { type: "process.started";  process_name: string; pid: number; cwd: string; command: string; ts: number }
  | { type: "process.log";      process_name: string; stream: "stdout" | "stderr" | "event"; line: string; level?: "error" | "warn" | "info"; ts: number }
  | { type: "process.exited";   process_name: string; exit_code: number | null; signal: string | null; ts: number }
  | { type: "stat.collected";   session_id: string; stat_id: number; ts: number }
  | { type: "pr.changed";       reason: "ingest" | "reconcile" | "full-sync"; ts: number }
  | { type: "error.reported";   source: string; message: string; detail?: Record<string, unknown>; ts: number }
  | { type: "session.inject";   target_session_id: string; text: string; source: string | null; author_label?: string | null; ts: number }
  | { type: "transcript.frame"; target_session_id: string; seq: number; kind: string; payload: unknown; ts: number }
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
      options: Array<string | { label: string; description?: string }>;
      multi_select?: boolean;
      requester_platform?: "discord" | "slack";
      requester_user_id?: string;
      ts: number;
    }
  | { type: "question.answered"; target_session_id: string; question_id: number; answer_index: number; answer_text: string; ts: number }
  | { type: "question.resolved"; target_session_id: string; question_id: number; ts: number }
  | { type: "federation.site.connected";    site_id: string; ts: number }
  | { type: "federation.site.disconnected"; site_id: string; ts: number }
  | { type: "ping";             ts: number };

export type ConcordiaEvent = ConcordiaEventPayload & { v?: WsFrameVersion };
type Listener = (ev: ConcordiaEvent) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const KNOWN_WS_TYPES = new Set<string>([
  "hello",
  "session.started",
  "session.lost",
  "session.ended",
  "session.event",
  "session.task_changed",
  "session.message",
  "session.message.summary",
  "chat.posted",
  "task.enqueued",
  "skill.snapshot",
  "report.generated",
  "rule.changed",
  "delegation.templates_changed",
  "process.started",
  "process.log",
  "process.exited",
  "stat.collected",
  "pr.changed",
  "error.reported",
  "session.inject",
  "transcript.frame",
  "session.permission_request",
  "question.posted",
  "question.answered",
  "question.resolved",
  "ping",
]);

function normalizeWsFrame(input: unknown): ConcordiaEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const frame = input as { type?: unknown; v?: unknown };
  if (typeof frame.type !== "string") return null;
  if (!KNOWN_WS_TYPES.has(frame.type)) return null;
  if (frame.v !== undefined && frame.v !== 1) return null;
  return { ...(input as Record<string, unknown>), v: 1 } as ConcordiaEvent;
}

class ConcordiaWsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private connected = false;
  private url: string;

  constructor() {
    const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:11111";
    this.url = `${proto}//${host}/ws`;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.intentionalClose = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
    });
    this.ws.addEventListener("message", (e) => {
      let parsed: ConcordiaEvent | null = null;
      try { parsed = normalizeWsFrame(JSON.parse(e.data)); } catch { return; }
      if (!parsed) return;
      for (const l of this.listeners) {
        try { l(parsed); } catch { /* swallow */ }
      }
    });
    this.ws.addEventListener("close", () => {
      this.connected = false;
      this.ws = null;
      if (!this.intentionalClose) this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // close ハンドラに任せる
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* swallow */ } this.ws = null; }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 全 event を受け取る. unsubscribe 関数を返す. */
  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 特定の event type のみ. unsubscribe 関数を返す. */
  onEvent<T extends ConcordiaEvent["type"]>(
    type: T,
    listener: (ev: Extract<ConcordiaEvent, { type: T }>) => void,
  ): () => void {
    const wrapped: Listener = (ev) => {
      if (ev.type === type) listener(ev as Extract<ConcordiaEvent, { type: T }>);
    };
    return this.onMessage(wrapped);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const wsClient = new ConcordiaWsClient();
