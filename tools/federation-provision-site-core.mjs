/**
 * federation-provision-site の純関数部分 (引数解析・本社 URL 組立・Excubitor catalog の port 読み取り・応答判定)。
 * I/O は federation-provision-site.mjs が持つ。token はここを通っても文字列として返さない。
 */

const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const SITE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const USAGE = "usage: node tools/federation-provision-site.mjs --peer <Excubitor peer id> --site-id <id> [--name <表示名>] [--hq-url <ws://...>] [--dry-run]";

/** argv (process.argv.slice(2)) を解析する。不正なら { error } を返す。 */
export function parseProvisionArgs(argv) {
  const out = { peer: null, siteId: null, name: null, hqUrl: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--peer") out.peer = next() ?? null;
    else if (arg === "--site-id") out.siteId = next() ?? null;
    else if (arg === "--name") out.name = next() ?? null;
    else if (arg === "--hq-url") out.hqUrl = next() ?? null;
    else if (arg === "--dry-run") out.dryRun = true;
    else return { error: `unknown argument: ${arg}\n${USAGE}` };
  }
  if (!out.peer) return { error: `--peer is required\n${USAGE}` };
  if (!out.siteId || !SITE_ID.test(out.siteId)) return { error: `--site-id must match [a-z0-9][a-z0-9-]{1,63}\n${USAGE}` };
  return { value: out };
}

/** 本社に繋ぐ側が平文 ws を張ってよい host か (Concordia src/federation/transport-policy.ts と同じ規則)。 */
export function isPlainWsHost(host) {
  const h = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || TAILNET_V4.test(h) || /^fd7a:115c:a1e0(:|$)/.test(h);
}

/**
 * 本社 listener の状態 (GET /v1/federation/listener) から拠点が繋ぐ URL を組む。
 * 動いていない、または loopback / tailnet 以外に bind しているなら理由を返す。
 */
export function hqUrlFromListener(listener) {
  const running = listener?.running;
  if (!listener?.enabled || !running?.host || !running?.port) return { error: "本社の連合 listener が動いていません (GET /v1/federation/listener)" };
  const host = String(running.host);
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
    return { error: "本社 listener が loopback に bind されています。拠点から届く tailnet のアドレスへ bind するか --hq-url を指定してください" };
  }
  if (!isPlainWsHost(host)) return { error: `本社 listener の bind 先 ${host} は tailnet ではありません。--hq-url に wss:// を指定してください` };
  const literal = host.includes(":") ? `[${host}]` : host;
  return { value: `ws://${literal}:${running.port}/federation/ws` };
}

/** --hq-url の指定を検証する (ws は loopback / tailnet IP だけ)。 */
export function validateHqUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return { error: `--hq-url が URL ではありません: ${raw}` }; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return { error: "--hq-url は ws:// か wss:// にしてください" };
  if (url.protocol === "ws:" && !isPlainWsHost(url.hostname)) return { error: "平文 ws:// は loopback / tailnet の IP 宛てだけです。wss:// を使ってください" };
  if (!url.pathname || url.pathname === "/") url.pathname = "/federation/ws";
  return { value: url.toString() };
}

/**
 * Excubitor catalog (excubitor.catalog.yaml) の文字列から code: excubitor の port を読む。
 * YAML パーサを持ち込まず、`- code: excubitor` の直後に現れる最初の `port:` を採る。
 */
export function excubitorPortFromCatalog(text) {
  const lines = String(text).split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const code = /^\s*-\s*code:\s*["']?([\w-]+)["']?\s*$/.exec(line);
    if (code) { inBlock = code[1] === "excubitor"; continue; }
    if (!inBlock) continue;
    const port = /^\s+port:\s*(\d+)\s*$/.exec(line);
    if (port) return Number(port[1]);
  }
  return null;
}

/** 本文 (token を含む) を組む。呼び元はこれをログに出さない。 */
export function buildSiteOperation({ hqUrl, siteId, token }) {
  return {
    target: { kind: "service", code: "concordia" },
    action: "concordia-federation-site",
    federation_site: { hq_url: hqUrl, site_id: siteId, token },
  };
}

/** 依頼の状態が終わったか。 */
export function isFinalStatus(status) {
  return status === "succeeded" || status === "failed";
}

/** GET /v1/federation の一覧から当該拠点の接続状態を拾う。 */
export function siteConnection(listing, siteId) {
  const site = (listing?.sites ?? []).find((s) => s.site_id === siteId);
  return site ? { status: site.status, connection: site.connection, site_version: site.site_version ?? null } : null;
}
