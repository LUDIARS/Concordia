/**
 * 連合リンクの設定読み込み (env)。既定は両ロールとも OFF (opt-in)。
 *
 * 信頼境界 (spec/plan/multi-site-federation.md Phase 0):
 * - 連合 listener は /v1 HTTP サーバとは別ポート・別 origin。既定 OFF。
 * - port は明示必須 (暗黙の既定 port で外部面を立てない。port の正本は
 *   Excubitor catalog — 運用登録してから有効化する)。
 * - TLS は前段のトンネル / 逆プロキシで終端する前提。拠点クライアント側は
 *   loopback 以外への平文 ws:// を拒否する (site-client.ts)。
 */

export interface FederationEnv {
  /** 本社ロール: 連合 listener を立てるか (CONCORDIA_FEDERATION_LISTEN=1)。 */
  listenEnabled: boolean;
  listenHost: string;
  /** listener port。listenEnabled のとき必須 (未指定は起動時エラー)。 */
  listenPort: number | null;
  /** 拠点ロール: 接続先本社 URL (wss://…)。未設定なら拠点クライアントは起動しない。 */
  hqUrl: string | null;
  siteId: string | null;
  siteToken: string | null;
  /** 拠点別 outbox の上限行数 (超過は最古から破棄)。 */
  outboxMaxRows: number;
  /** outbox エントリの TTL 秒 (超過は破棄)。 */
  outboxTtlSec: number;
}

const DEFAULT_OUTBOX_MAX_ROWS = 10_000;
const DEFAULT_OUTBOX_TTL_SEC = 7 * 24 * 60 * 60;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readFederationEnv(env: NodeJS.ProcessEnv = process.env): FederationEnv {
  const listenEnabled = env.CONCORDIA_FEDERATION_LISTEN === "1";
  const portRaw = Number(env.CONCORDIA_FEDERATION_LISTEN_PORT);
  const listenPort = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : null;
  if (listenEnabled && listenPort === null) {
    throw new Error(
      "CONCORDIA_FEDERATION_LISTEN=1 requires CONCORDIA_FEDERATION_LISTEN_PORT (no implicit default port)",
    );
  }
  return {
    listenEnabled,
    listenHost: env.CONCORDIA_FEDERATION_LISTEN_HOST?.trim() || "127.0.0.1",
    listenPort,
    hqUrl: env.CONCORDIA_FEDERATION_HQ_URL?.trim() || null,
    siteId: env.CONCORDIA_FEDERATION_SITE_ID?.trim() || null,
    siteToken: env.CONCORDIA_FEDERATION_SITE_TOKEN?.trim() || null,
    outboxMaxRows: readPositiveInt(env.CONCORDIA_FEDERATION_OUTBOX_MAX, DEFAULT_OUTBOX_MAX_ROWS),
    outboxTtlSec: readPositiveInt(env.CONCORDIA_FEDERATION_OUTBOX_TTL_SEC, DEFAULT_OUTBOX_TTL_SEC),
  };
}
