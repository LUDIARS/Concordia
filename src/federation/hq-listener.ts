/**
 * 連合 listener (本社側)。
 *
 * 信頼境界 (spec/plan/multi-site-federation.md Phase 0):
 * - 既存の /v1 HTTP サーバ (loopback 信頼境界) とは別の node:http サーバ +
 *   別ポートで立てる。既定 OFF の opt-in (bootstrap/core.ts が env を見て起動)。
 * - この面で受け付ける操作は protocol.ts で定義したフレームだけ。/v1 への
 *   透過転送経路は作らない (HTTP リクエストは全て 404)。
 * - TLS は前段のトンネル / 逆プロキシで終端する。
 *
 * 接続フロー: hello (期限内・先頭フレーム) → トークン照合 (定数時間) →
 * welcome → outbox 配送 (seq 昇順) → ack で削除。死活は WS ping/pong。
 */

import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventBus } from "../events.js";
import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";
import type { FederationSitesRepo } from "../db/federation-sites-repo.js";
import type { FederationOutboxRepo } from "../db/federation-outbox-repo.js";
import type { FederationConnections } from "./hq-connections.js";
import {
  parseFederationFrame,
  serializeFederationFrame,
  type FederationErrorCode,
} from "./protocol.js";
import type { FederationConfigSnapshot } from "./protocol.js";
import type { FederationEgressRequestFrame, FederationFrameInput } from "./protocol.js";

const log = createChildLogger("federation/hq");

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const DELIVERY_BATCH = 100;
/** 認証失敗レート制限: 窓内の失敗がこの回数を超えた remote は hello を見ずに切る。 */
const AUTH_FAILURE_LIMIT = 5;
const AUTH_FAILURE_WINDOW_MS = 60_000;
/**
 * フレーム全体の上限。この面は (トンネル経由で) 外部公開されうるので、
 * ws 既定の 100MB は許さない。認証後は egress-request が本文 (protocol.ts で
 * 8,000 文字上限) を運ぶので、UTF-8 で 3 バイト級の文字が並んでも収まる幅を取る。
 * ws の maxPayload 超過は接続ごと 1009 で落とすため、ここを本文上限より狭くすると
 * 長文 1 通で連合リンクが切れて再接続ループに入る。
 */
const MAX_FRAME_BYTES = 64 * 1024;
/**
 * 認証前フレームの上限。hello は site_id + token + version だけなので 8KB で十分。
 * 未認証の相手に 64KB を許さないための、ハンドシェイク中だけの追加の絞り。
 */
const MAX_PRE_AUTH_FRAME_BYTES = 8 * 1024;
/**
 * hello 待ち (未認証) 接続の同時数上限。認証失敗を伴わない接続だけを大量に開くと
 * レート制限に記録が残らないため、ここで別に頭を押さえる。
 *
 * 全体上限だけだと、1 つの攻撃元が hello を送らない接続を上限まで張り続けるだけで
 * 全拠点の再接続を締め出せる (hello 待ちは 10 秒 = 張り替えれば恒久的に占有できる)。
 * remote 単位の上限を併せて課し、締め出しを発信元の中に閉じ込める。
 */
const MAX_PENDING_HANDSHAKES = 64;
const MAX_PENDING_HANDSHAKES_PER_REMOTE = 4;

export interface FederationListenerDeps {
  host: string;
  port: number;
  sites: FederationSitesRepo;
  outbox: FederationOutboxRepo;
  connections: FederationConnections;
  /** welcome で名乗る本社バージョン (package.json version 等)。 */
  hqVersion: string;
  nowSec?: () => number;
  /** 設定の正本は HQ だけにあり、接続ごとに現在値を組み立てて送る。 */
  createConfigSnapshot?: (siteId: string) => FederationConfigSnapshot;
  /** Discord 実体は bootstrap から注入する。federation は chat 層を知らない。 */
  handleEgressRequest?: (siteId: string, request: FederationEgressRequestFrame) => Promise<{ ok: boolean; error?: string }>;
}

export interface FederationListenerHandle {
  port: number;
  /** 接続中なら即時配送、切断中は outbox 保持。dropped>0 はエラーチャンネルへ通知済み。 */
  enqueue(siteId: string, payload: unknown): { seq: number; dropped: number };
  /** 拠点の live 接続を明示的に切る (revoke 時など)。 */
  disconnect(siteId: string, code: FederationErrorCode): void;
  /** 明示的な再配布は link 中の site へだけ update として送る。 */
  sendConfigUpdate(siteId: string): boolean;
  send(siteId: string, frame: FederationFrameInput): boolean;
  close(): void;
}

interface LiveSocket {
  ws: WebSocket;
  lastSentSeq: number;
  isAlive: boolean;
}

export function startFederationListener(deps: FederationListenerDeps): Promise<FederationListenerHandle> {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const sockets = new Map<string, LiveSocket>();
  const authFailures = new Map<string, { count: number; windowStartMs: number }>();
  /** hello 待ちの接続数 (MAX_PENDING_HANDSHAKES の分母)。 */
  let pendingHandshakes = 0;
  /** remote 別の hello 待ち接続数。 0 になったら消す (エントリを溜めない)。 */
  const pendingByRemote = new Map<string, number>();

  // 連合面は WS 専用。HTTP リクエストへは何も生やさない (/v1 透過転送の禁止)。
  const server: HttpServer = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "federation endpoint is WebSocket only" }));
  });
  const wss = new WebSocketServer({ server, path: "/federation/ws", maxPayload: MAX_FRAME_BYTES });
  wss.on("error", (err) => log.error({ err: (err as Error).message }, "federation wss error"));

  function sendError(ws: WebSocket, code: FederationErrorCode, message: string): void {
    try {
      ws.send(serializeFederationFrame({ type: "error", code, message }));
    } catch { /* closing anyway */ }
  }

  function recordAuthFailure(remote: string): void {
    const now = Date.now();
    const entry = authFailures.get(remote);
    if (!entry || now - entry.windowStartMs > AUTH_FAILURE_WINDOW_MS) {
      authFailures.set(remote, { count: 1, windowStartMs: now });
      return;
    }
    entry.count += 1;
  }

  function isRateLimited(remote: string): boolean {
    const entry = authFailures.get(remote);
    if (!entry) return false;
    if (Date.now() - entry.windowStartMs > AUTH_FAILURE_WINDOW_MS) return false;
    return entry.count >= AUTH_FAILURE_LIMIT;
  }

  function deliverPending(siteId: string): void {
    const socket = sockets.get(siteId);
    if (!socket || socket.ws.readyState !== WebSocket.OPEN) return;
    const rows = deps.outbox.listPending(siteId, socket.lastSentSeq, DELIVERY_BATCH);
    for (const row of rows) {
      let payload: unknown = null;
      try { payload = JSON.parse(row.payload); } catch { /* keep null */ }
      try {
        socket.ws.send(serializeFederationFrame({ type: "event", seq: row.seq, payload }));
        socket.lastSentSeq = row.seq;
      } catch (e) {
        log.warn({ siteId, err: (e as Error).message }, "federation event send failed");
        return;
      }
    }
  }

  function send(siteId: string, frame: FederationFrameInput): boolean {
    const socket = sockets.get(siteId);
    if (!socket || socket.ws.readyState !== WebSocket.OPEN) return false;
    try {
      socket.ws.send(serializeFederationFrame(frame));
      return true;
    } catch (e) {
      log.warn({ siteId, err: (e as Error).message }, "federation direct frame send failed");
      return false;
    }
  }

  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress ?? "unknown";
    if (isRateLimited(remote)) {
      log.warn({ remote }, "federation connection rejected: auth failure rate limit");
      ws.close(1008, "rate limited");
      return;
    }

    const remotePending = pendingByRemote.get(remote) ?? 0;
    if (pendingHandshakes >= MAX_PENDING_HANDSHAKES || remotePending >= MAX_PENDING_HANDSHAKES_PER_REMOTE) {
      log.warn(
        { remote, pending: pendingHandshakes, remotePending },
        "federation connection rejected: too many pending handshakes",
      );
      ws.close(1013, "try again later");
      return;
    }
    pendingHandshakes += 1;
    pendingByRemote.set(remote, remotePending + 1);
    let handshakePending = true;
    /** hello 待ちを抜けた (認証成功 or 切断) ときに一度だけ数を戻す。 */
    const settleHandshake = (): void => {
      if (!handshakePending) return;
      handshakePending = false;
      pendingHandshakes -= 1;
      const left = (pendingByRemote.get(remote) ?? 1) - 1;
      if (left > 0) pendingByRemote.set(remote, left);
      else pendingByRemote.delete(remote);
    };

    let siteId: string | null = null;
    const helloTimer = setTimeout(() => {
      if (!siteId) {
        sendError(ws, "auth_failed", "hello timeout");
        ws.close(1008, "hello timeout");
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    ws.on("error", (err) => log.warn({ remote, siteId, err: (err as Error).message }, "federation socket error"));

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (!siteId && Buffer.byteLength(text) > MAX_PRE_AUTH_FRAME_BYTES) {
        log.warn({ remote }, "federation frame rejected: too large before hello");
        recordAuthFailure(remote);
        sendError(ws, "invalid_frame", "frame too large before hello");
        ws.close(1008, "frame too large");
        return;
      }
      const parsed = parseFederationFrame(text);
      if (!parsed.ok) {
        // 監査ログ: 何を拒否したか (値そのものは出さない)。
        log.warn({ remote, siteId, reason: parsed.reason, detail: parsed.detail }, "federation frame rejected");
        if (!siteId) {
          recordAuthFailure(remote);
          sendError(ws, parsed.reason === "unsupported_version" ? "unsupported_version" : "invalid_frame", parsed.reason);
          ws.close(1008, parsed.reason);
        }
        return;
      }
      const frame = parsed.frame;

      if (!siteId) {
        // 認証前は hello 以外を受け付けない。
        if (frame.type !== "hello") {
          recordAuthFailure(remote);
          sendError(ws, "auth_failed", "hello required first");
          ws.close(1008, "hello required");
          return;
        }
        if (!deps.sites.verifyToken(frame.site_id, frame.token)) {
          recordAuthFailure(remote);
          log.warn({ remote, siteId: frame.site_id }, "federation auth failed");
          sendError(ws, "auth_failed", "invalid site credentials");
          ws.close(1008, "auth failed");
          return;
        }
        clearTimeout(helloTimer);
        settleHandshake();
        // 正しいトークンを出せた remote の失敗記録は捨てる。残したままだと、
        // 起動直後に数回失敗した拠点が (成功後の再接続で) 窓が閉じるまで弾かれる。
        authFailures.delete(remote);
        siteId = frame.site_id;
        const siteVersion = frame.site_version ?? null;

        // 同一拠点の旧接続は置き換える (拠点プロセス再起動後の残骸対策)。
        const existing = sockets.get(siteId);
        if (existing) {
          sendError(existing.ws, "replaced", "a newer connection for this site was established");
          try { existing.ws.close(1000, "replaced"); } catch { /* already closing */ }
        }

        sockets.set(siteId, { ws, lastSentSeq: 0, isAlive: true });
        deps.sites.touchConnected(siteId, siteVersion);
        deps.connections.attach({
          siteId,
          connectedAtSec: nowSec(),
          lastSeenSec: nowSec(),
          siteVersion,
          remoteAddress: remote,
        });
        eventBus.emit({ type: "federation.site.connected", site_id: siteId, ts: nowSec() });
        log.info({ siteId, remote }, "federation site connected");
        ws.send(serializeFederationFrame({
          type: "welcome",
          hq_version: deps.hqVersion,
          pending_events: deps.outbox.pendingCount(siteId),
        }));
        ws.send(serializeFederationFrame({
          type: "config-snapshot",
          snapshot: createConfigSnapshot(siteId),
        }));
        deliverPending(siteId);
        return;
      }

      if (frame.type === "egress-request") {
        void (async () => {
          const result = deps.handleEgressRequest
            ? await deps.handleEgressRequest(siteId!, frame)
            : { ok: false, error: "HQ egress is unavailable" };
          send(siteId!, {
            type: "egress-result",
            request_id: frame.request_id,
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
          });
        })().catch((e) => {
          log.warn({ siteId, err: (e as Error).message }, "federation egress request failed");
          send(siteId!, { type: "egress-result", request_id: frame.request_id, ok: false, error: "HQ egress failed" });
        });
        return;
      }

      if (frame.type === "ack") {
        // 送っていない seq を ack させない。そのまま信じると、認証済みの拠点が
        // (バグでも故意でも) 大きな seq を投げるだけで未配送分を outbox から
        // 消せてしまう (= 静かなイベント欠落)。再接続直後の古い ack も同様に
        // lastSentSeq=0 で無効化され、再送 → 再 ack で正しく収束する。
        const acked = sockets.get(siteId);
        const ackSeq = Math.min(frame.seq, acked?.lastSentSeq ?? 0);
        if (ackSeq > 0) deps.outbox.ackUpTo(siteId, ackSeq);
        deps.sites.touchSeen(siteId);
        deps.connections.touch(siteId, nowSec());
        deliverPending(siteId);
        return;
      }
      // 認証後の hello / event / welcome 等は連合面で許可した操作ではない。
      log.warn({ siteId, type: frame.type }, "federation frame ignored (not allowed from site)");
    });

    ws.on("pong", () => {
      if (!siteId) return;
      const socket = sockets.get(siteId);
      if (socket) socket.isAlive = true;
      deps.sites.touchSeen(siteId);
      deps.connections.touch(siteId, nowSec());
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      settleHandshake();
      if (!siteId) return;
      const socket = sockets.get(siteId);
      // replace 済みの旧接続の close で新接続を消さない。
      if (socket && socket.ws === ws) {
        sockets.delete(siteId);
        deps.connections.detach(siteId);
        eventBus.emit({ type: "federation.site.disconnected", site_id: siteId, ts: nowSec() });
        log.info({ siteId }, "federation site disconnected");
      }
    });
  });

  const pingTimer = setInterval(() => {
    // 期限切れの認証失敗記録を捨てる。これをしないと remote アドレスごとに
    // エントリが残り続け、外部公開面で無制限にメモリが増える。
    const now = Date.now();
    for (const [remote, entry] of authFailures) {
      if (now - entry.windowStartMs > AUTH_FAILURE_WINDOW_MS) authFailures.delete(remote);
    }
    for (const [id, socket] of sockets) {
      if (!socket.isAlive) {
        log.warn({ siteId: id }, "federation site heartbeat lost; terminating");
        try { socket.ws.terminate(); } catch { /* already dead */ }
        continue;
      }
      socket.isAlive = false;
      try { socket.ws.ping(); } catch { /* close handler cleans up */ }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  const handle: FederationListenerHandle = {
    port: deps.port,
    enqueue(siteId, payload) {
      const result = deps.outbox.enqueue(siteId, payload);
      if (result.dropped > 0) {
        reportError(
          "federation",
          `連合 outbox 上限で拠点 ${siteId} の古いイベントを ${result.dropped} 件破棄しました`,
          { site_id: siteId, dropped: result.dropped },
        );
      }
      deliverPending(siteId);
      return result;
    },
    disconnect(siteId, code) {
      const socket = sockets.get(siteId);
      if (!socket) return;
      sendError(socket.ws, code, `disconnected by hq: ${code}`);
      // close の完了を待たずにレジストリから外す。失効 (revoke) の直後に配送を
      // 止めたいのに、経路断で TCP が半開のままだと close が来ず、次の ping 周期
      // (25 秒) まで enqueue が失効済み拠点へ配送を続けてしまう。
      // close ハンドラは sockets を引けなくなるので、切断イベントはここで出す。
      sockets.delete(siteId);
      deps.connections.detach(siteId);
      eventBus.emit({ type: "federation.site.disconnected", site_id: siteId, ts: nowSec() });
      log.info({ siteId, code }, "federation site disconnected by hq");
      try { socket.ws.close(1000, code); } catch { /* already closing */ }
    },
    sendConfigUpdate(siteId) {
      const socket = sockets.get(siteId);
      if (!socket || socket.ws.readyState !== WebSocket.OPEN) return false;
      try {
        socket.ws.send(serializeFederationFrame({
          type: "config-update",
          snapshot: createConfigSnapshot(siteId),
        }));
        return true;
      } catch (e) {
        log.warn({ siteId, err: (e as Error).message }, "federation config update send failed");
        return false;
      }
    },
    send,
    close() {
      clearInterval(pingTimer);
      for (const socket of sockets.values()) {
        try { socket.ws.close(1001, "hq shutting down"); } catch { /* ignore */ }
      }
      wss.close();
      server.close();
    },
  };

  function createConfigSnapshot(siteId: string): FederationConfigSnapshot {
    return deps.createConfigSnapshot?.(siteId) ?? { discord: {}, templates: [] };
  }

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      // bind 失敗時は呼び出し側に handle が渡らない = close() されない。
      // ここで自分の後始末をしないと ping timer と wss が残る。
      clearInterval(pingTimer);
      wss.close();
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(deps.port, deps.host, () => {
      server.off("error", onError);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : deps.port;
      log.info({ host: deps.host, port: boundPort }, "federation listener started");
      resolve({ ...handle, port: boundPort });
    });
  });
}
