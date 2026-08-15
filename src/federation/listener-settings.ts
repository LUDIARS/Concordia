/**
 * 連合 listener (本社ロール) の有効化設定。
 *
 * 従来は env だけで、有効化に「env を注入して Concordia を再起動する」ことが必須だった。
 * env 注入は Excubitor が担っているため、実質 Excubitor 無しでは拠点を受けられない。
 * 連合は Concordia 自身の機能なので、**Cc の設定 (DB) だけで完結**させ、env は代替手段に
 * 落とす (2026-08-09 neco 指示: Excubitor 依存の多い作りにしない)。
 *
 * 解決順は DB → env → 既定。 `WorkflowToggles` と同じ形で、呼ばれるたびに解決するので
 * 設定変更は再起動なしで次の tick から効く。
 */

import type { SettingsStore } from "../admin/settings-store.js";
import type { FederationEnv } from "./env.js";
import { SITE_ID_PATTERN } from "./protocol.js";

export const FEDERATION_SITE_HQ_URL_KEY = "admin.federation.site.hq_url";
export const FEDERATION_SITE_ID_KEY = "admin.federation.site.site_id";
/** 拠点トークンは秘匿値なので暗号化して置く (平文は API から二度と返さない)。 */
export const FEDERATION_SITE_TOKEN_KEY = "admin.federation.site.token_enc";

export const FEDERATION_LISTEN_ENABLED_KEY = "admin.federation.listen.enabled";
export const FEDERATION_LISTEN_PORT_KEY = "admin.federation.listen.port";
export const FEDERATION_LISTEN_HOST_KEY = "admin.federation.listen.host";

/** 拠点は別 PC から繋ぐので、既定の bind 先は loopback のまま (明示的に広げさせる)。 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

export type SettingSource = "db" | "env" | "default";

export interface FederationListenerConfig {
  enabled: boolean;
  /** 有効時は必須。 既定ポートは作らない (取り違えを事故にしないため)。 */
  port: number | null;
  host: string;
  source: { enabled: SettingSource; port: SettingSource; host: SettingSource };
}

export interface FederationListenerPatch {
  enabled?: boolean;
  port?: number | null;
  host?: string | null;
}

const TRUE_PATTERN = /^(1|true|yes|on)$/i;
const FALSE_PATTERN = /^(0|false|no|off)$/i;

export function isValidListenPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;
}

export function resolveFederationListener(
  store: SettingsStore,
  env: FederationEnv,
): FederationListenerConfig {
  const enabledRaw = store.get(FEDERATION_LISTEN_ENABLED_KEY);
  const portRaw = store.get(FEDERATION_LISTEN_PORT_KEY);
  const hostRaw = store.get(FEDERATION_LISTEN_HOST_KEY);

  const enabled = readBoolean(enabledRaw);
  const port = readPort(portRaw);
  const host = hostRaw?.trim() ? hostRaw.trim() : null;

  return {
    enabled: enabled ?? env.listenEnabled,
    port: port ?? env.listenPort,
    host: host ?? env.listenHost,
    source: {
      enabled: enabled === null ? (env.listenEnabled ? "env" : "default") : "db",
      port: port === null ? (env.listenPort === null ? "default" : "env") : "db",
      host: host === null ? (env.listenHost === DEFAULT_LISTEN_HOST ? "default" : "env") : "db",
    },
  };
}

/**
 * 設定を書き換える。 `enabled=true` にするならポートが要る — 既定ポートを作らない方針なので、
 * 「有効なのに待ち受け先が無い」状態を作らせない。
 */
export function updateFederationListener(
  store: SettingsStore,
  env: FederationEnv,
  patch: FederationListenerPatch,
): { ok: true; config: FederationListenerConfig } | { ok: false; error: string } {
  if (patch.port !== undefined && patch.port !== null && !isValidListenPort(patch.port)) {
    return { ok: false, error: "port must be an integer between 1 and 65535" };
  }
  if (patch.host !== undefined && patch.host !== null && !patch.host.trim()) {
    return { ok: false, error: "host must not be empty" };
  }
  if (patch.host !== undefined && patch.host !== null
    && (patch.host.trim().length > 200 || /[\u0000-\u0020\u007f]/.test(patch.host.trim()))) {
    return { ok: false, error: "host must be at most 200 characters and contain no whitespace or control characters" };
  }

  return store.transaction(() => {
    const next = { ...resolveFederationListener(store, env) };
    if (patch.port !== undefined) next.port = patch.port ?? env.listenPort;
    if (patch.host !== undefined) next.host = patch.host?.trim() || env.listenHost;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (next.enabled && next.port === null) {
      return { ok: false as const, error: "enabling the federation listener requires a port" };
    }

    if (patch.enabled !== undefined) store.set(FEDERATION_LISTEN_ENABLED_KEY, patch.enabled ? "1" : "0");
    if (patch.port === null) store.delete(FEDERATION_LISTEN_PORT_KEY);
    else if (patch.port !== undefined) store.set(FEDERATION_LISTEN_PORT_KEY, String(patch.port));
    if (patch.host === null) store.delete(FEDERATION_LISTEN_HOST_KEY);
    else if (patch.host !== undefined) store.set(FEDERATION_LISTEN_HOST_KEY, patch.host.trim());

    return { ok: true as const, config: resolveFederationListener(store, env) };
  });
}

/** 起動中の listener を張り替える必要があるか (ポート/ホスト変更は閉じて開き直す)。 */
export function listenerNeedsRestart(
  running: { port: number; host: string } | null,
  desired: FederationListenerConfig,
): "start" | "stop" | "restart" | "none" {
  const wanted = desired.enabled && desired.port !== null;
  if (!wanted) return running ? "stop" : "none";
  if (!running) return "start";
  return running.port === desired.port && running.host === desired.host ? "none" : "restart";
}

/** 拠点ロール (本社へ繋ぎに行く側) の設定。 3 つ揃って初めてクライアントが起動する。 */
export interface FederationSiteConfig {
  hqUrl: string | null;
  siteId: string | null;
  /** 平文は返さない。 設定済みかどうかだけ。 */
  hasToken: boolean;
  source: { hqUrl: SettingSource; siteId: SettingSource; token: SettingSource };
}

export interface FederationSitePatch {
  hq_url?: string | null;
  site_id?: string | null;
  token?: string | null;
}

/** 暗号化トークンの復号口。 SecretBox をそのまま受けると循環依存になるので最小形で受ける。 */
export interface TokenCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export function resolveFederationSite(
  store: SettingsStore,
  env: FederationEnv,
  cipher: TokenCipher,
): FederationSiteConfig & { token: string | null; tokenDecryptionFailed: boolean } {
  const hqUrl = store.get(FEDERATION_SITE_HQ_URL_KEY)?.trim() || null;
  const siteId = store.get(FEDERATION_SITE_ID_KEY)?.trim() || null;
  const stored = store.get(FEDERATION_SITE_TOKEN_KEY)?.trim() || null;
  let token: string | null = null;
  let tokenDecryptionFailed = false;
  if (stored) {
    try {
      token = cipher.decrypt(stored);
    } catch {
      // 鍵が入れ替わった等で読めない。env へのフォールバック自体は維持するが、
      // 呼び元が運用面へ必ず表面化できるよう失敗状態を返す。
      token = null;
      tokenDecryptionFailed = true;
    }
  }
  return {
    hqUrl: hqUrl ?? env.hqUrl,
    siteId: siteId ?? env.siteId,
    token: token ?? env.siteToken,
    tokenDecryptionFailed,
    hasToken: Boolean(token ?? env.siteToken),
    source: {
      hqUrl: hqUrl ? "db" : env.hqUrl ? "env" : "default",
      siteId: siteId ? "db" : env.siteId ? "env" : "default",
      token: token ? "db" : env.siteToken ? "env" : "default",
    },
  };
}

export function updateFederationSite(
  store: SettingsStore,
  cipher: TokenCipher,
  patch: FederationSitePatch,
): { ok: true } | { ok: false; error: string } {
  if (patch.hq_url !== undefined && patch.hq_url !== null) {
    const raw = patch.hq_url.trim();
    if (raw.length === 0 || raw.length > 500) {
      return { ok: false, error: "hq_url must contain between 1 and 500 characters" };
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        return { ok: false, error: "hq_url must use ws:// or wss://" };
      }
      if (url.username || url.password) {
        return { ok: false, error: "hq_url must not contain credentials" };
      }
      if (url.hash) return { ok: false, error: "hq_url must not contain a fragment" };
    } catch {
      return { ok: false, error: "hq_url must be a valid ws:// or wss:// URL" };
    }
  }
  if (patch.site_id !== undefined && patch.site_id !== null && !SITE_ID_PATTERN.test(patch.site_id.trim())) {
    return { ok: false, error: "site_id must match [a-z0-9][a-z0-9-]{1,63}" };
  }
  if (patch.token !== undefined && patch.token !== null) {
    const token = patch.token.trim();
    if (token.length === 0 || token.length > 500) {
      return { ok: false, error: "token must contain between 1 and 500 characters" };
    }
  }

  return store.transaction(() => {
    if (patch.hq_url === null) store.delete(FEDERATION_SITE_HQ_URL_KEY);
    else if (patch.hq_url !== undefined) store.set(FEDERATION_SITE_HQ_URL_KEY, patch.hq_url.trim());
    if (patch.site_id === null) store.delete(FEDERATION_SITE_ID_KEY);
    else if (patch.site_id !== undefined) store.set(FEDERATION_SITE_ID_KEY, patch.site_id.trim());
    if (patch.token === null) store.delete(FEDERATION_SITE_TOKEN_KEY);
    else if (patch.token !== undefined) store.set(FEDERATION_SITE_TOKEN_KEY, cipher.encrypt(patch.token.trim()));
    return { ok: true as const };
  });
}

/** 起動中の拠点クライアントを張り替える必要があるか。 */
export function siteClientNeedsRestart(
  running: { hqUrl: string; siteId: string; token: string } | null,
  desired: { hqUrl: string | null; siteId: string | null; token: string | null },
): "start" | "stop" | "restart" | "none" {
  const wanted = Boolean(desired.hqUrl && desired.siteId && desired.token);
  if (!wanted) return running ? "stop" : "none";
  if (!running) return "start";
  return running.hqUrl === desired.hqUrl && running.siteId === desired.siteId && running.token === desired.token
    ? "none"
    : "restart";
}

function readBoolean(value: string | null): boolean | null {
  if (value === null || value.trim() === "") return null;
  if (TRUE_PATTERN.test(value.trim())) return true;
  if (FALSE_PATTERN.test(value.trim())) return false;
  return null;
}

function readPort(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const port = Number(value.trim());
  return isValidListenPort(port) ? port : null;
}
