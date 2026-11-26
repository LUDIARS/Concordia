/**
 * 海外監視の判定 (契約 v1 §2 海外監視)。
 *
 * - `CF-IPCountry` / `CF-Connecting-IP` を読む。 許可国 (既定 JP) 以外は「海外」。
 * - `T1` (Tor) と `XX` (不明) は許可国外として扱う。
 * - Cloudflare を通っていない接続 (CF ヘッダ無し かつ 送信元が loopback 以外) は拒否。
 * - 方針 `block` なら海外は拒否 (4403)、 `monitor` なら通して記録と通知だけ。
 *
 * 純関数。 記録と通知は application 層が判定結果を見て行う。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-GEO)
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:cef76509 */
import augurContract_161967d4 from './geo-verdict.contract.js'; /* augur-inject:contract-predicate:2db73b22 */

export type GeoPolicy = "monitor" | "block";
export const DEFAULT_GEO_POLICY: GeoPolicy = "block";
export const DEFAULT_ALLOWED_COUNTRIES: readonly string[] = ["JP"];
/** 国として扱わない Cloudflare の特別値。 どちらも許可国外。 */
const NON_COUNTRY_CODES = new Set(["T1", "XX"]);

export interface GeoInput {
  readonly cfCountry: string | null;
  readonly cfConnectingIp: string | null;
  readonly remoteAddress: string | null;
  readonly allowedCountries: readonly string[];
  readonly policy: GeoPolicy;
}

export type GeoVerdict = {
  readonly allow: boolean;
  /** 記録・通知に使う理由。 */
  readonly reason: "loopback" | "allowed_country" | "overseas_monitored" | "overseas_blocked" | "not_via_cloudflare";
  /** 海外判定か (monitor で通した場合も true)。 */
  readonly overseas: boolean;
  readonly country: string | null;
  /** 記録用。 末尾をマスクした送信元。 */
  readonly maskedIp: string | null;
};

function header(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** IPv4-mapped (`::ffff:127.0.0.1`) を含めて loopback か。 */
export function isLoopbackAddress(address: string | null): boolean {
  if (!address) return false;
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::1") return true;
  const v4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** IPv4 は最終オクテット、 IPv6 は先頭 3 グループ以外を伏せる。 形が分からなければ全部伏せる。 */
export function maskIp(address: string | null): string | null {
  if (!address) return null;
  const value = address.trim().replace(/^\[|\]$/g, "");
  const v4 = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : value;
  const octets = v4.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.*`;
  }
  if (value.includes(":")) {
    const groups = value.split(":").filter((group) => group !== "");
    return `${groups.slice(0, 3).join(":")}:*`;
  }
  return "*";
}

/** 許可国の設定値 (`JP,US` など) を正規化する。 空なら既定 (JP)。 */
export function parseAllowedCountries(raw: string | null | undefined): string[] {
  const codes = (raw ?? "").split(/[\s,]+/).map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code) && !NON_COUNTRY_CODES.has(code));
  return codes.length > 0 ? [...new Set(codes)] : [...DEFAULT_ALLOWED_COUNTRIES];
}

export function parseGeoPolicy(raw: string | null | undefined): GeoPolicy {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "monitor") return "monitor";
  if (value === "block") return "block";
  return DEFAULT_GEO_POLICY;
}

export function evaluateGeo(input: GeoInput): GeoVerdict {
  const cfCountry = header(input.cfCountry)?.toUpperCase() ?? null;
  const cfIp = header(input.cfConnectingIp);
  const viaCloudflare = cfCountry !== null || cfIp !== null;
  if (!viaCloudflare) {
    // Cloudflare を経ない直結は、 同じ PC (loopback) からの開発接続だけ許す。
    if (isLoopbackAddress(input.remoteAddress)) {
      return { allow: true, reason: "loopback", overseas: false, country: null, maskedIp: maskIp(input.remoteAddress) };
    }
    return { allow: false, reason: "not_via_cloudflare", overseas: false, country: null, maskedIp: maskIp(input.remoteAddress) };
  }
  const maskedIp = maskIp(cfIp ?? input.remoteAddress);
  const allowed = new Set(input.allowedCountries.map((code) => code.toUpperCase()));
  const inAllowedCountry = cfCountry !== null && !NON_COUNTRY_CODES.has(cfCountry) && allowed.has(cfCountry);
  if (inAllowedCountry) return { allow: true, reason: "allowed_country", overseas: false, country: cfCountry, maskedIp };
  if (input.policy === "block") {
    return { allow: false, reason: "overseas_blocked", overseas: true, country: cfCountry, maskedIp };
  }
  return { allow: true, reason: "overseas_monitored", overseas: true, country: cfCountry, maskedIp };
}
// @ts-expect-error augur-inject
evaluateGeo = contract(evaluateGeo, { ...augurContract_161967d4, contractId: 'guh-C-3', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/geo-policy.ts:85', rule: 'contract-wrap', id: '161967d4' }); /* augur-inject:contract-wrap:161967d4 */
