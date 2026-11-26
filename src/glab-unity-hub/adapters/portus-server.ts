/**
 * Hub の待受 (Portus の HTTP と WebSocket、 契約 v1 §2 エンドポイント)。
 *
 * - `GET /health`
 * - WS `/v1/glab-unity/ws` (Portus の http サーバの upgrade で受け、 Portus の WebSocket に渡す)
 * - `POST /v1/glab-unity/melpomene/reports` (gzip 可、 展開後 ≤ 5 MiB)
 *
 * 待受は常に loopback。 外部公開は Cloudflare Tunnel の公開ホスト名経由 (Access なし、 トークンで守る)。
 * ここは通信路の付け替えだけを持ち、 判断は application 層 (HubSession / MelpomeneHttpEndpoint) が行う。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-PORTUS)
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createGunzip } from "node:zlib";
import { MAX_FRAME_BYTES } from "../domain/protocol.js";
import { MAX_REPORT_BODY_BYTES } from "../domain/melpomene-report.js";
import type { ConnectionOrigin } from "../application/geo-guard.js";
import type { HubSocket } from "../application/hub-session.js";
import type { HttpReply } from "../application/melpomene-http.js";
import type { PortusHttpServerLike, PortusModules, PortusRequestContext } from "./portus-loader.js";

export const HUB_WS_PATH = "/v1/glab-unity/ws";
export const MELPOMENE_PATH = "/v1/glab-unity/melpomene/reports";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PING_INTERVAL_MS = 30_000;

/** 1 接続ぶんの受け手 (HubSession を包む)。 */
export interface HubConnectionHandler {
  start(): Promise<void>;
  receive(data: Buffer, isBinary: boolean): Promise<void>;
  closed(): void;
}

export interface PortusHubServerDeps {
  readonly portus: PortusModules;
  readonly health: () => unknown;
  readonly openConnection: (input: { socket: HubSocket; origin: ConnectionOrigin; authorization: string | string[] | undefined }) => HubConnectionHandler;
  readonly melpomene: (input: { origin: ConnectionOrigin; authorization: string | string[] | undefined; bodyText: string }) => Promise<HttpReply>;
  readonly log?: (message: string) => void;
}

function headerValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : null;
}

/** 要求ヘッダと送信元から海外監視の入力を作る。 */
export function originOf(req: Pick<IncomingMessage, "headers" | "socket">): ConnectionOrigin {
  return {
    cfCountry: headerValue(req.headers["cf-ipcountry"]),
    cfConnectingIp: headerValue(req.headers["cf-connecting-ip"]),
    remoteAddress: req.socket?.remoteAddress ?? null,
  };
}

/** RFC 6455 の Sec-WebSocket-Accept。 */
export function websocketAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function hasToken(value: string | string[] | undefined, token: string): boolean {
  const text = Array.isArray(value) ? value.join(",") : value ?? "";
  return text.split(",").some((part) => part.trim().toLowerCase() === token);
}

/** upgrade 要求の検査。 問題があれば理由、 無ければ null。 */
export function upgradeProblem(req: Pick<IncomingMessage, "method" | "url" | "headers">): string | null {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== HUB_WS_PATH) return "not found";
  if (req.method !== "GET") return "method must be GET";
  if (!hasToken(req.headers.upgrade, "websocket")) return "missing upgrade: websocket";
  if (!hasToken(req.headers.connection, "upgrade")) return "missing connection: upgrade";
  if (req.headers["sec-websocket-version"] !== "13") return "unsupported websocket version";
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) return "invalid sec-websocket-key";
  return null;
}

/**
 * gzip の本文を展開した要求に差し替える。 Portus の本文読み取り (上限付き) が展開後の
 * バイト数に上限を掛けるので、 展開爆弾も 5 MiB で止まる。
 */
export function gunzipRequest(req: IncomingMessage): IncomingMessage {
  const gunzip = createGunzip();
  req.pipe(gunzip);
  req.on("error", (error) => gunzip.destroy(error));
  const headers = { ...req.headers };
  delete headers["content-length"];
  delete headers["content-encoding"];
  return Object.assign(gunzip, { headers, method: req.method, url: req.url, socket: req.socket }) as unknown as IncomingMessage;
}

export class PortusHubServer {
  private http: PortusHttpServerLike | null = null;
  private readonly sockets = new Set<{ ping(): void; close(code?: number, reason?: string): void }>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PortusHubServerDeps) {}

  async listen(port: number, host = "127.0.0.1"): Promise<number> {
    const { portus } = this.deps;
    const http = portus.createHttpServer({
      maxBodyBytes: MAX_REPORT_BODY_BYTES,
      routes: [
        { method: "GET", path: "/health", handler: () => portus.json(this.deps.health()), note: "GLab-UnityHub health" },
        { method: "POST", path: MELPOMENE_PATH, handler: (ctx) => this.melpomene(ctx), note: "Melpomene bug report" },
      ],
    });
    this.wrapGzip(http);
    http.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    this.http = http;
    const address = await http.listen(port, host);
    this.pingTimer = setInterval(() => { for (const ws of this.sockets) ws.ping(); }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    return address.port;
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const ws of this.sockets) ws.close(1001, "server shutting down");
    this.sockets.clear();
    await this.http?.close();
    this.http = null;
  }

  private async melpomene(ctx: PortusRequestContext): Promise<unknown> {
    const reply = await this.deps.melpomene({ origin: originOf(ctx.req), authorization: ctx.req.headers.authorization, bodyText: ctx.body });
    return this.deps.portus.json(reply.body, reply.status);
  }

  /** gzip の要求だけ本文を展開してから Portus の処理へ渡す。 */
  private wrapGzip(http: PortusHttpServerLike): void {
    const listeners = http.server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    if (listeners.length !== 1) return;
    const portusHandler = listeners[0]!;
    http.server.removeAllListeners("request");
    http.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const encoding = headerValue(req.headers["content-encoding"])?.toLowerCase();
      if (encoding === "gzip") {
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > MAX_REPORT_BODY_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "invalid_request", message: "payload too large" } }));
          req.resume();
          return;
        }
        portusHandler(gunzipRequest(req), res);
        return;
      }
      portusHandler(req, res);
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const problem = upgradeProblem(req);
    if (problem) {
      const status = problem === "not found" ? "404 Not Found" : "400 Bad Request";
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${problem}`);
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(String(req.headers["sec-websocket-key"]))}`,
      "", "",
    ].join("\r\n"));
    const ws = new this.deps.portus.WebSocket(false, MAX_FRAME_BYTES);
    const connection = this.deps.openConnection({
      socket: { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason.slice(0, 120)) },
      origin: originOf(req),
      authorization: req.headers.authorization,
    });
    const entry = { ping: () => ws.ping(), close: (code?: number, reason?: string) => ws.close(code, reason) };
    this.sockets.add(entry);
    ws.on("message", (data, isBinary) => {
      void connection.receive(data, isBinary).catch((error: unknown) => this.deps.log?.(`hub message failed: ${String(error)}`));
    });
    ws.on("close", () => {
      this.sockets.delete(entry);
      connection.closed();
    });
    ws.on("error", (error) => this.deps.log?.(`hub websocket error: ${error.message}`));
    ws.attach(socket, head);
    void connection.start().catch((error: unknown) => this.deps.log?.(`hub connection start failed: ${String(error)}`));
  }
}
