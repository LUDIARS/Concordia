/**
 * Cernere の project WS (`/ws/project`) への 1 本の接続。
 *
 * project token は `POST /api/auth/login` (grant_type: project_credentials) で取り、期限まで使い回す
 * (Cernere 側の発行上限が 10 回 / 300 秒なので、要求ごとに取り直さない)。
 * 要求は `module_request` に request_id を付けて送り、`module_response` / `error` を同じ id で受ける。
 *
 * 失敗は 2 種類に分ける。Cernere が拒否した (CernereRejectedError) のか、
 * 届かなかった (CernereUnavailableError) のか。どちらでも公開側は拒否するが、応答の status と記録が違う。
 */

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export class CernereRejectedError extends Error {}
export class CernereUnavailableError extends Error {}

export interface ProjectChannelOptions {
  cernereUrl: string;
  clientId: string;
  clientSecret: string;
  /** 1 要求の待ち時間 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  createSocket?: (url: string) => WebSocket;
}

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** project token をこの秒数だけ早めに取り直す (接続中に期限で切られないように)。 */
const TOKEN_MARGIN_SECONDS = 60;

export class CernereProjectChannel {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: (url: string) => WebSocket;
  private token: { value: string; expiresAt: number } | null = null;
  private socket: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly options: ProjectChannelOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  async request(module: string, action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new CernereUnavailableError("channel closed");
    const socket = await this.connect();
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CernereUnavailableError("Cernere did not answer in time"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "module_request", request_id: requestId, module, action, payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new CernereUnavailableError("failed to send to Cernere"));
      }
    });
  }

  close(): void {
    this.closed = true;
    const current = this.socket;
    this.socket = null;
    this.failPending(new CernereUnavailableError("channel closed"));
    void current?.then((ws) => ws.close()).catch(() => undefined);
  }

  private async connect(): Promise<WebSocket> {
    const now = Math.floor(Date.now() / 1000);
    if (this.socket && this.token && this.token.expiresAt - TOKEN_MARGIN_SECONDS > now) {
      const ws = await this.socket.catch(() => null);
      if (ws && ws.readyState === WebSocket.OPEN) return ws;
    }
    if (this.socket) {
      const stale = this.socket;
      this.socket = null;
      void stale.then((ws) => ws.close()).catch(() => undefined);
    }
    this.socket = this.open();
    try {
      return await this.socket;
    } catch (error) {
      this.socket = null;
      throw error;
    }
  }

  private async open(): Promise<WebSocket> {
    const token = await this.projectToken();
    const url = new URL("/ws/project", this.options.cernereUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    const ws = this.createSocket(url.toString());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new CernereUnavailableError("Cernere project socket did not open in time"));
      }, this.timeoutMs);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", () => { clearTimeout(timer); reject(new CernereUnavailableError("Cernere project socket failed")); });
    });
    ws.on("error", () => undefined);
    ws.on("message", (data) => this.onMessage(ws, data.toString()));
    ws.on("close", () => {
      if (this.socket) void this.socket.then((current) => { if (current === ws) this.socket = null; }).catch(() => undefined);
      this.failPending(new CernereUnavailableError("Cernere project socket closed"));
    });
    return ws;
  }

  private onMessage(ws: WebSocket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", ts: msg.ts })); } catch { /* close で後始末 */ }
      return;
    }
    const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
    const entry = requestId ? this.pending.get(requestId) : undefined;
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (msg.type === "module_response") entry.resolve(msg.payload);
    else entry.reject(new CernereRejectedError(typeof msg.message === "string" ? msg.message : "Cernere rejected the request"));
  }

  private failPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private async projectToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_SECONDS > now) return this.token.value;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.cernereUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "project_credentials",
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CernereUnavailableError("Cernere project login unreachable");
    }
    if (!response.ok) {
      // 資格情報の誤りも 5xx も、公開側から見れば「Cernere で確かめられない」。
      throw new CernereUnavailableError(`Cernere project login failed (${response.status})`);
    }
    const body = await response.json().catch(() => ({})) as { accessToken?: unknown; expiresIn?: unknown };
    if (typeof body.accessToken !== "string" || !body.accessToken) {
      throw new CernereUnavailableError("Cernere project login returned no token");
    }
    const expiresIn = typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn : 3600;
    this.token = { value: body.accessToken, expiresAt: now + expiresIn };
    return body.accessToken;
  }
}
