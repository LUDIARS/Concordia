/**
 * 連合クライアント (拠点側)。拠点 → 本社への outbound WS 接続を維持する。
 *
 * - 接続後すぐ hello を送り、welcome を受けてから link 確立とみなす。
 * - event フレームは onEvent へ渡し、受領した seq を ack する (Phase 1 では
 *   payload の解釈はしない — 設定配布 / ルーティングは Phase 2+)。
 * - 切断時は指数バックオフ (1s → 2 倍 → 上限 60s、welcome 成功でリセット)。
 * - 拠点間はマシンを跨ぐため、loopback 以外への平文 ws:// は拒否する
 *   (TLS はトンネル / 逆プロキシで終端した wss:// を指す)。
 */

import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { reportError } from "../errors.js";
import { createChildLogger } from "../shared/logger.js";
import {
  FEDERATION_PROTOCOL_VERSION,
  parseFederationFrame,
  serializeFederationFrame,
} from "./protocol.js";
import {
  defaultFederationConfigCachePath,
  readFederationConfigCache,
  writeFederationConfigCache,
} from "./config-cache.js";
import type { FederationConfigSnapshot } from "./protocol.js";
import type { FederationEgressResultFrame } from "./protocol.js";

const log = createChildLogger("federation/site");

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/**
 * 本社からの受信が途絶えたと見切るまでの時間。本社は 25 秒間隔で ping を撃つので、
 * 3 周期弱を無音で過ごしたら経路が死んでいる。TCP の半開 (経路断・本社の異常終了) は
 * close イベントを起こさないため、これが無いと拠点側は「接続中」のまま永久に
 * 再接続しない (OS の keepalive は既定 2 時間)。
 */
const HQ_IDLE_TIMEOUT_MS = 70_000;
const HQ_IDLE_CHECK_MS = 10_000;
const EGRESS_TIMEOUT_MS = 30_000;

export interface FederationSiteClientDeps {
  hqUrl: string;
  siteId: string;
  token: string;
  /** hello で名乗る拠点バージョン。 */
  siteVersion: string;
  /** OS platform used for template resolution at HQ. */
  platform?: "win32" | "darwin";
  onEvent?: (payload: unknown, seq: number) => void;
  /** welcome 受信 (link 確立) 通知。テスト / 起動ログ用。 */
  onLinked?: (info: { hqVersion: string; pendingEvents: number }) => void;
  /** 本社設定の更新通知。キャッシュ起動値も link 前に一度渡す。 */
  onConfig?: (config: FederationConfigSnapshot) => void;
  /** テストまたは埋め込み時の保存先。未指定なら cwd の固定キャッシュ。 */
  configCachePath?: string;
}

export interface FederationSiteClientHandle {
  stop(): void;
  isLinked(): boolean;
  getConfig(): FederationConfigSnapshot | null;
  requestEgress(input: { requestId?: string; guildId: string; channelId: string; text: string }): Promise<FederationEgressResultFrame>;
}

/** loopback 以外への平文 ws:// を拒否する。戻り値は正規化済み接続 URL。 */
export function resolveHqEndpoint(hqUrl: string): string {
  const url = new URL(hqUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`federation HQ URL must be ws(s)://, got ${url.protocol}`);
  }
  // URL.hostname は IPv6 を角括弧付き ("[::1]") で返すので剥がしてから比べる。
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (url.protocol === "ws:" && !loopback) {
    throw new Error("plain ws:// to a non-loopback HQ is not allowed; use wss:// (TLS-terminating tunnel)");
  }
  if (!url.pathname || url.pathname === "/") url.pathname = "/federation/ws";
  return url.toString();
}

export function startFederationSiteClient(deps: FederationSiteClientDeps): FederationSiteClientHandle {
  const endpoint = resolveHqEndpoint(deps.hqUrl);
  const configCachePath = deps.configCachePath ?? defaultFederationConfigCachePath();
  let config = readFederationConfigCache(configCachePath);
  if (config) deps.onConfig?.(config);
  let stopped = false;
  let linked = false;
  let backoffMs = BACKOFF_INITIAL_MS;
  let ws: WebSocket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  const pendingEgress = new Map<string, { resolve: (result: FederationEgressResultFrame) => void; timer: NodeJS.Timeout }>();

  const rejectPendingEgress = (error: string): void => {
    for (const [requestId, pending] of pendingEgress) {
      clearTimeout(pending.timer);
      pending.resolve({ v: FEDERATION_PROTOCOL_VERSION, type: "egress-result", request_id: requestId, ok: false, error });
    }
    pendingEgress.clear();
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    retryTimer = setTimeout(connect, backoffMs);
    retryTimer.unref?.();
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  };

  const connect = () => {
    if (stopped) return;
    // ハンドラは必ずこの socket を見る。再接続後に古い socket のハンドラが遅れて
    // 発火しても、外側の可変 ws (= 新しい接続) へ ack を撃たないようにするため。
    const socket = new WebSocket(endpoint);
    ws = socket;

    let lastActivityMs = Date.now();
    const markActive = () => { lastActivityMs = Date.now(); };
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivityMs <= HQ_IDLE_TIMEOUT_MS) return;
      log.warn({ idleMs: Date.now() - lastActivityMs }, "federation link idle; terminating to reconnect");
      // terminate は close を発火させるので、再接続は既存の close ハンドラに任せる。
      try { socket.terminate(); } catch { /* already dead */ }
    }, HQ_IDLE_CHECK_MS);
    idleTimer.unref?.();

    socket.on("open", () => {
      markActive();
      socket.send(serializeFederationFrame({
        type: "hello",
        site_id: deps.siteId,
        token: deps.token,
        site_version: deps.siteVersion,
        ...(deps.platform ? { platform: deps.platform } : {}),
      }));
    });
    socket.on("ping", markActive);
    socket.on("pong", markActive);

    socket.on("message", (raw) => {
      markActive();
      const parsed = parseFederationFrame(raw.toString());
      if (!parsed.ok) {
        log.warn({ reason: parsed.reason, detail: parsed.detail }, "federation frame rejected (from hq)");
        return;
      }
      const frame = parsed.frame;
      if (frame.type === "welcome") {
        linked = true;
        backoffMs = BACKOFF_INITIAL_MS;
        log.info({ hqVersion: frame.hq_version, pending: frame.pending_events, v: FEDERATION_PROTOCOL_VERSION }, "federation link established");
        deps.onLinked?.({ hqVersion: frame.hq_version, pendingEvents: frame.pending_events });
        return;
      }
      if (frame.type === "event") {
        try {
          deps.onEvent?.(frame.payload, frame.seq);
        } catch (e) {
          log.warn({ err: (e as Error).message, seq: frame.seq }, "federation onEvent handler failed");
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serializeFederationFrame({ type: "ack", seq: frame.seq }));
        }
        return;
      }
      if (frame.type === "config-snapshot" || frame.type === "config-update") {
        // link 後は本社の値が唯一の正本。古いオフラインキャッシュを必ず置き換える。
        config = frame.snapshot;
        try {
          writeFederationConfigCache(configCachePath, config);
        } catch (e) {
          log.warn({ err: (e as Error).message }, "federation config cache write failed");
        }
        deps.onConfig?.(config);
        return;
      }
      if (frame.type === "egress-result") {
        const pending = pendingEgress.get(frame.request_id);
        if (!pending) return;
        pendingEgress.delete(frame.request_id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
      if (frame.type === "error") {
        log.warn({ code: frame.code, message: frame.message }, "federation error from hq");
        // 失効 / 認証失敗は再接続しても直らない — 停止して人間の再設定を待つ。
        // 黙って連合リンクを畳むと気付けないので、エラーチャンネルにも上げる。
        if (frame.code === "revoked" || frame.code === "auth_failed") {
          stopped = true;
          reportError(
            "federation",
            `連合リンクを停止しました (${frame.code})。本社でのトークン再発行と CONCORDIA_FEDERATION_SITE_TOKEN の再設定が必要です`,
            { site_id: deps.siteId, code: frame.code },
          );
        }
        return;
      }
      log.warn({ type: frame.type }, "federation frame ignored (not expected from hq)");
    });

    socket.on("close", () => {
      // 置き換え済みの古い socket の後始末で、新しい接続の watchdog を止めない。
      if (ws === socket && idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      if (ws !== socket) return;
      linked = false;
      rejectPendingEgress("HQ link closed before egress completed");
      if (stopped) return;
      log.info({ backoffMs }, "federation link closed; reconnecting");
      scheduleReconnect();
    });

    socket.on("error", (e) => {
      log.warn({ err: (e as Error).message }, "federation link error");
      // close が続けて発火するので再接続は close 側で行う。
    });
  };

  connect();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      try { ws?.close(1000, "site shutting down"); } catch { /* ignore */ }
      rejectPendingEgress("site client stopped");
    },
    isLinked() {
      return linked;
    },
    getConfig() {
      return config;
    },
    requestEgress(input) {
      const requestId = input.requestId ?? randomUUID();
      // 同じ id を二重に走らせると、先行分の timer が後発分の pending を消して
      // どちらか一方が永久に resolve しない。呼び出し側の id 衝突はここで断る。
      if (pendingEgress.has(requestId)) {
        return Promise.resolve({ v: FEDERATION_PROTOCOL_VERSION, type: "egress-result", request_id: requestId, ok: false, error: "an egress request with this id is already in flight" });
      }
      if (!linked || !ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve({ v: FEDERATION_PROTOCOL_VERSION, type: "egress-result", request_id: requestId, ok: false, error: "HQ link is not connected" });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingEgress.delete(requestId);
          resolve({ v: FEDERATION_PROTOCOL_VERSION, type: "egress-result", request_id: requestId, ok: false, error: "egress request timed out after 30 seconds" });
        }, EGRESS_TIMEOUT_MS);
        timer.unref?.();
        pendingEgress.set(requestId, { resolve, timer });
        try {
          ws!.send(serializeFederationFrame({ type: "egress-request", request_id: requestId, guild_id: input.guildId, channel_id: input.channelId, text: input.text }));
        } catch (e) {
          pendingEgress.delete(requestId);
          clearTimeout(timer);
          resolve({ v: FEDERATION_PROTOCOL_VERSION, type: "egress-result", request_id: requestId, ok: false, error: (e as Error).message });
        }
      });
    },
  };
}
