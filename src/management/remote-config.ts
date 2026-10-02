import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { parseCfAccessConfig, type CfAccessConfig } from "./cf-access.js";

/**
 * dots 専用の入口 (CC-MGMT-07) の設定。 既定 OFF、 有効時はポート必須 (暗黙の既定ポートで
 * 外部面を立てない)。 ポートの正本は Concordia の Excubitor catalog。
 * host に `tailscale` を指定すると、 この PC の Tailscale アドレス (100.64.0.0/10) に bind する
 * (マシン固有の IP を catalog に書かないため)。
 */

export interface ManagementRemoteConfig {
  host: string;
  port: number;
  /**
   * Cloudflare Tunnel 経由の公開 (CC-MGMT-08)。 この Host 宛ての要求には Access の JWT を必須にする。
   * Tailscale から直接来る要求 (Host が IP) には課さない。 access が null (team / aud 未設定) の間は
   * 公開 Host 宛てを全部拒否する (公開側を検証なしで開けない)。
   */
  publicAccess?: { host: string; access: CfAccessConfig | null };
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Excubitor runtime-config (cf:ex-access が書く cloudflareAccess) から team / aud を読む。 */
function runtimeAccess(raw: string | undefined): { teamDomain?: string; audience?: string } {
  if (!raw?.trim()) return {};
  try {
    const config = JSON.parse(raw) as { cloudflareAccess?: { teamDomain?: unknown; audience?: unknown } };
    const access = config.cloudflareAccess;
    return {
      ...(typeof access?.teamDomain === "string" ? { teamDomain: access.teamDomain } : {}),
      ...(typeof access?.audience === "string" ? { audience: access.audience } : {}),
    };
  } catch {
    throw new Error("EXCUBITOR_SERVICE_CONFIG_JSON is not valid JSON");
  }
}

/**
 * 公開ホストの設定。 team / aud は専用 env を優先し、 無ければ Excubitor runtime-config から読む。
 * 両方とも未設定なら access=null (公開側は全拒否、 Tailscale 側は動かす)。 片方だけ・形式不正は throw。
 */
export function readPublicAccess(env: Readonly<Record<string, string | undefined>>): ManagementRemoteConfig["publicAccess"] {
  const host = env.CONCORDIA_MANAGEMENT_PUBLIC_HOST?.trim().toLowerCase();
  if (!host) return undefined;
  if (!HOSTNAME.test(host)) throw new Error("CONCORDIA_MANAGEMENT_PUBLIC_HOST must be a hostname");
  const runtime = runtimeAccess(env.EXCUBITOR_SERVICE_CONFIG_JSON);
  const access = parseCfAccessConfig(
    env.CONCORDIA_MANAGEMENT_CF_ACCESS_TEAM_DOMAIN ?? runtime.teamDomain,
    env.CONCORDIA_MANAGEMENT_CF_ACCESS_AUD ?? runtime.audience,
  );
  return { host, access };
}

export const DEFAULT_REMOTE_HOST = "127.0.0.1";
export const TAILSCALE_HOST_KEYWORD = "tailscale";
/** 本文の上限。 dots の依頼 1 件は数 KB なので余裕を持って 64KiB。 */
export const REMOTE_MAX_BODY_BYTES = 64 * 1024;

type Interfaces = () => Record<string, NetworkInterfaceInfo[] | undefined>;

/** 100.64.0.0/10 (CGNAT 帯、 Tailscale が割り当てる範囲)。 */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function findTailscaleAddress(interfaces: Interfaces = networkInterfaces): string | null {
  for (const entries of Object.values(interfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isTailscaleAddress(entry.address)) return entry.address;
    }
  }
  return null;
}

/** 無効なら null。 有効なのに値が不正なら throw (起動時に設定ミスを隠さない)。 */
export function readManagementRemoteConfig(
  env: Readonly<Record<string, string | undefined>>,
  interfaces: Interfaces = networkInterfaces,
): ManagementRemoteConfig | null {
  if (env.CONCORDIA_MANAGEMENT_LISTEN !== "1") return null;
  const port = Number(env.CONCORDIA_MANAGEMENT_LISTEN_PORT);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error("CONCORDIA_MANAGEMENT_LISTEN=1 requires CONCORDIA_MANAGEMENT_LISTEN_PORT (no implicit default port)");
  }
  const publicAccess = readPublicAccess(env);
  const raw = env.CONCORDIA_MANAGEMENT_LISTEN_HOST?.trim() || DEFAULT_REMOTE_HOST;
  let host = raw;
  if (raw.toLowerCase() === TAILSCALE_HOST_KEYWORD) {
    const found = findTailscaleAddress(interfaces);
    if (!found) throw new Error("CONCORDIA_MANAGEMENT_LISTEN_HOST=tailscale but no Tailscale (100.64.0.0/10) address was found");
    host = found;
  }
  return { host, port, ...(publicAccess ? { publicAccess } : {}) };
}
