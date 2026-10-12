/** 拠点がオフライン起動時だけ使う、最後に本社から受け取った設定のキャッシュ。 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FederationConfigSnapshot } from "./protocol.js";
import { parseHqStaffRoles } from "../staff/hq-staff-roles.js";

export function defaultFederationConfigCachePath(cwd = process.cwd()): string {
  return resolve(cwd, ".federation-config-cache.json");
}

export function readFederationConfigCache(path: string): FederationConfigSnapshot | null {
  try {
    return parseFederationConfigCache(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeFederationConfigCache(path: string, config: FederationConfigSnapshot): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseFederationConfigCache(value: unknown): FederationConfigSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { discord?: unknown; templates?: unknown };
  if (!candidate.discord || typeof candidate.discord !== "object" || Array.isArray(candidate.discord)) return null;
  if (!Array.isArray(candidate.templates)) return null;
  const discord = Object.entries(candidate.discord);
  if (!discord.every(([key, item]) => typeof key === "string" && typeof item === "string")) return null;
  if (!candidate.templates.every(isTemplate)) return null;
  const staffRoles = (value as { staff_roles?: unknown }).staff_roles;
  return {
    discord: Object.fromEntries(discord) as Record<string, string>,
    templates: candidate.templates,
    // 本社の役職 (SPEC-FED-STAFF-ROLES)。 壊れた行は捨て、 権限を与える側に倒さない。
    ...(Array.isArray(staffRoles) ? { staff_roles: parseHqStaffRoles(JSON.stringify(staffRoles)) } : {}),
  };
}

function isTemplate(value: unknown): value is FederationConfigSnapshot["templates"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.call_name === "string" &&
    typeof row.title === "string" && typeof row.target_provider === "string" &&
    (typeof row.model === "string" || row.model === null);
}
