/**
 * 連合リンクの通信路ポリシー (純関数)。
 *
 * 拠点間は Tailscale (WireGuard で暗号化された tailnet) で結ぶ運用を正とする
 * (2026-10-06 neco 判断)。tailnet のアドレスは IP リテラルで判定できるので、
 * 平文 ws:// は「loopback か tailnet の IP リテラル宛て」に限って許す。
 * ホスト名 (MagicDNS を含む) は名前解決先を検証できないため、平文では許さない。
 *
 * - CC-FED-T1: 拠点クライアントは loopback / tailnet IP 以外への平文 ws:// を拒否する。
 * - CC-FED-T2: 本社 listener は loopback / tailnet 以外からの接続を hello 前に切る。
 * - CC-FED-T3: 拠点設定の保存時点で T1 に反する本社 URL を拒否する (listener-settings.ts)。
 */

/** Tailscale が払い出す IPv4 (CGNAT 100.64.0.0/10)。 */
function isTailnetIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Tailscale の IPv6 ULA (fd7a:115c:a1e0::/48)。 */
function isTailnetIpv6(host: string): boolean {
  return /^fd7a:115c:a1e0(:|$)/i.test(host);
}

/** IPv4-mapped IPv6 ("::ffff:100.1.2.3") と角括弧を剥がした素のアドレスにする。 */
export function normalizeAddress(address: string): string {
  const bare = address.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  return mapped ? mapped[1] : bare;
}

export function isLoopbackAddress(address: string): boolean {
  const host = normalizeAddress(address).toLowerCase();
  if (host === "::1" || host === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function isTailnetAddress(address: string): boolean {
  const host = normalizeAddress(address);
  return isTailnetIpv4(host) || isTailnetIpv6(host);
}

/** CC-FED-T1: 平文 ws:// を張ってよい宛先か。 */
export function isPlainWsAllowedHost(hostname: string): boolean {
  return isLoopbackAddress(hostname) || isTailnetAddress(hostname);
}

/** CC-FED-T2: 連合 listener が受け付ける接続元か。 */
export function isAllowedFederationRemote(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return isLoopbackAddress(remoteAddress) || isTailnetAddress(remoteAddress);
}

/**
 * CC-FED-T1 / T3: 本社 URL を検証する。 ws / wss 以外、 または平文 ws の宛先が loopback / tailnet で
 * なければ理由を返す (問題なければ null)。
 */
export function hqUrlTransportError(hqUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(hqUrl);
  } catch {
    return "hq_url must be a valid ws:// or wss:// URL";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return "hq_url must use ws:// or wss://";
  if (url.protocol === "ws:" && !isPlainWsAllowedHost(url.hostname)) {
    return "plain ws:// is allowed only to loopback or a tailnet IP (100.64.0.0/10, fd7a:115c:a1e0::/48); use wss:// otherwise";
  }
  return null;
}
