/**
 * 公開ホストの SSO 設定 (spec/feature/web-sso.md「設定」)。
 *
 * CONCORDIA_WEB_PUBLIC_HOST が無ければ機能は無効 (null) で、今までの動作のまま。
 * 公開ホストを有効にしたのに Cernere の情報が欠けていれば、公開ホストを素通しで
 * 開けてしまわないよう起動を止める (例外を投げる)。
 */

export interface WebSsoConfig {
  /** 公開ホスト名 (小文字、ポート無し) */
  publicHost: string;
  /** Cernere の base URL (末尾の / は落とす) */
  cernereUrl: string;
  projectKey: string;
  clientId: string;
  clientSecret: string;
}

export class WebSsoConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function readWebSsoConfig(env: Env = process.env): WebSsoConfig | null {
  const publicHost = env.CONCORDIA_WEB_PUBLIC_HOST?.trim().toLowerCase() ?? "";
  if (!publicHost) return null;
  if (!/^[a-z0-9.-]+$/.test(publicHost)) {
    throw new WebSsoConfigError("CONCORDIA_WEB_PUBLIC_HOST はホスト名だけを書く (スキーム・ポート・パスは付けない)");
  }
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name]?.trim() ?? "";
    if (!value) missing.push(name);
    return value;
  };
  const cernereUrl = read("CERNERE_URL");
  const projectKey = read("CONCORDIA_CERNERE_PROJECT_KEY");
  const clientId = read("CONCORDIA_CERNERE_CLIENT_ID");
  const clientSecret = read("CONCORDIA_CERNERE_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new WebSsoConfigError(`公開ホストを有効にするには ${missing.join(", ")} が要る`);
  }
  let parsed: URL;
  try {
    parsed = new URL(cernereUrl);
  } catch {
    throw new WebSsoConfigError("CERNERE_URL が URL として読めない");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WebSsoConfigError("CERNERE_URL は http(s) の URL にする");
  }
  return { publicHost, cernereUrl: cernereUrl.replace(/\/+$/, ""), projectKey, clientId, clientSecret };
}
