/**
 * 公開ホストの判定と Cookie の扱い (spec/feature/web-sso.md CC-SSO-INV-03 / INV-04)。
 * 入出力は文字列だけにして、HTTP (Hono) と WS (node:http) の両方から使う。
 */

export const SSO_COOKIE = "__Host-cc-sso";

/** Cloudflare Tunnel を通った要求に付くヘッダー。どれかがあれば公開側として扱う。 */
const TUNNEL_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion"] as const;

export type HeaderReader = (name: string) => string | undefined | null;

/** Host ヘッダーからポートを外して小文字にする。IPv6 の [..] はそのまま残す。 */
export function hostWithoutPort(host: string | undefined | null): string {
  const value = (host ?? "").trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(0, end + 1) : value;
  }
  const colon = value.indexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
}

/**
 * 公開側の要求か。Host が公開ホストに一致するか、トンネル由来のヘッダーがあれば公開側。
 * Host を書き換えて公開ホストを避けても、トンネルを通っていればヘッダーで捕まえる。
 */
export function isPublicRequest(publicHost: string, header: HeaderReader): boolean {
  if (hostWithoutPort(header("host")) === publicHost) return true;
  return TUNNEL_HEADERS.some((name) => Boolean(header(name)?.trim()));
}

/** 公開ホストで通す組織ロール。 */
export function roleAllowed(role: string | undefined | null): boolean {
  return role === "owner" || role === "admin";
}

/** Cookie ヘッダーから SSO の token を読む。無ければ空文字。 */
export function readSsoCookie(cookieHeader: string | undefined | null): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SSO_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return "";
    }
  }
  return "";
}

/** SSO token を置く Set-Cookie。maxAgeSeconds は Cernere が返した期限までの秒数。 */
export function ssoCookie(token: string, maxAgeSeconds: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${SSO_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

/** SSO token を消す Set-Cookie。 */
export function clearSsoCookie(): string {
  return `${SSO_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}
