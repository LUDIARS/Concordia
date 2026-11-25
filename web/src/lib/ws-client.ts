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

import { onBrowserResume } from "./browser-resume.js";

type WsFrameVersion = 1;

type ConcordiaEventPayload =
  | { type: "hello"; ts: number; service: string; session_id?: string | null; registered?: boolean }
  | { type: "session.started";  session_id: string; provider: string; repo_path: string; branch: string | null; ts: number }
  | { type: "session.lost";     session_id: string; ts: number }
  | { type: "session.ended";    session_id: string; ts: number }
  | { type: "session.event";    session_id: string; kind: string; ts: number }
  | { type: "operational.claim.opened" | "operational.claim.released"; target_session_id: string; ts: number }
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
// The server sends observer heartbeats every 25 seconds.
const SOCKET_STALE_MS = 60_000;
const KNOWN_WS_TYPES = new Set<string>([
  "hello",
  "session.started",
  "session.lost",
  "session.ended",
  "session.event",
  "operational.claim.opened",
  "operational.claim.released",
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

export class ConcordiaWsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopWatchingBrowser: (() => void) | null = null;
  private lastFrameAt = 0;
  private url: string;

  constructor() {
    const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:11111";
    this.url = `${proto}//${host}/ws`;
  }

  connect(): void {
    if (!this.stopWatchingBrowser && typeof window !== "undefined") {
      const unsubscribe = onBrowserResume(this.resume);
      window.addEventListener("offline", this.dropSocket);
      this.stopWatchingBrowser = () => {
        unsubscribe();
        window.removeEventListener("offline", this.dropSocket);
      };
    }
    if (this.ws || this.reconnectTimer !== null || this.isOffline()) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.lastFrameAt = Date.now();
    socket.addEventListener("message", (e) => {
      if (this.ws !== socket) return;
      let parsed: ConcordiaEvent | null = null;
      try { parsed = normalizeWsFrame(JSON.parse(e.data)); } catch { return; }
      if (!parsed) return;
      this.lastFrameAt = Date.now();
      if (parsed.type === "hello") this.reconnectAttempt = 0;
      if (parsed.type === "ping") return;
      for (const l of this.listeners) {
        try { l(parsed); } catch { /* swallow */ }
      }
    });
    socket.addEventListener("close", () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.stopWatchingBrowser?.();
    this.stopWatchingBrowser = null;
    this.dropSocket();
    this.reconnectAttempt = 0;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
    if (this.reconnectTimer !== null || this.isOffline()) return;
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

  private isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  private readonly dropSocket = (): void => {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    try { socket?.close(); } catch { /* The retired socket can no longer affect this client. */ }
  };

  private readonly resume = (): void => {
    if (this.isOffline()) return;
    if (this.ws && Date.now() - this.lastFrameAt < SOCKET_STALE_MS) return;
    this.dropSocket();
    this.connect();
  };
}

export const wsClient = new ConcordiaWsClient();
