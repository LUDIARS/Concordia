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

export type ConcordiaEvent =
  | { type: "hello"; ts: number; service: string }
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
  | { type: "stat.collected";   session_id: string; stat_id: number; ts: number }
  | { type: "ping";             ts: number };

type Listener = (ev: ConcordiaEvent) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

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
    const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:17330";
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
      try { parsed = JSON.parse(e.data); } catch { return; }
      if (!parsed || typeof parsed.type !== "string") return;
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
