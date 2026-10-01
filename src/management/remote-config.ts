import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * dots 専用の入口 (CC-MGMT-07) の設定。 既定 OFF、 有効時はポート必須 (暗黙の既定ポートで
 * 外部面を立てない)。 ポートの正本は Concordia の Excubitor catalog。
 * host に `tailscale` を指定すると、 この PC の Tailscale アドレス (100.64.0.0/10) に bind する
 * (マシン固有の IP を catalog に書かないため)。
 */

export interface ManagementRemoteConfig {
  host: string;
  port: number;
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
  const raw = env.CONCORDIA_MANAGEMENT_LISTEN_HOST?.trim() || DEFAULT_REMOTE_HOST;
  if (raw.toLowerCase() !== TAILSCALE_HOST_KEYWORD) return { host: raw, port };
  const host = findTailscaleAddress(interfaces);
  if (!host) throw new Error("CONCORDIA_MANAGEMENT_LISTEN_HOST=tailscale but no Tailscale (100.64.0.0/10) address was found");
  return { host, port };
}
