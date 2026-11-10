/**
 * 自動引き継ぎ・リポ担当の設定値 (env → 値) の adapter。
 *
 * 判定関数は env を読まず、 ここで読んだ値を受け取る (§4.2)。 監視は走査ごとに読み直すので、
 * env の変更は次の走査から効く。 壊れた値は既定値へ倒し、 warn で観測できるようにする
 * (整数でない閾値で機能ごと止めるより、 既定の安全側の値で動かす方が害が小さい)。
 *
 * @implements spec/feature/session-auto-succession.md §4.2
 */

import type { ContextHandoverSettings } from "./context-handover-policy.js";

export const DEFAULT_AUTO_HANDOVER_PCT = 70;
export const DEFAULT_AUTO_HANDOVER_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_QUIET_SEC = 60;
export const DEFAULT_REPO_AGENTS_MAX = 3;
export const DEFAULT_BRIEF_TIMEOUT_SEC = 600;

export interface RepoAgentSettings {
  enabled: boolean;
  maxAgentsPerParent: number;
  briefTimeoutSec: number;
}

export interface SuccessionSettings {
  handover: ContextHandoverSettings;
  repoAgents: RepoAgentSettings;
  quietSec: number;
}

type Env = Readonly<Record<string, string | undefined>>;
type Warn = (message: string) => void;

function readFlag(env: Env, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

function readPositiveInt(env: Env, name: string, fallback: number, warn: Warn): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  warn(`succession settings: ${name}=${raw} は正の整数でないため既定値 ${fallback} を使います`);
  return fallback;
}

export function readSuccessionSettings(env: Env, warn: Warn): SuccessionSettings {
  const pct = Math.min(100, readPositiveInt(env, "CONCORDIA_AUTO_HANDOVER_PCT", DEFAULT_AUTO_HANDOVER_PCT, warn));
  return {
    handover: {
      enabled: readFlag(env, "CONCORDIA_AUTO_HANDOVER", true),
      windowTokens: readPositiveInt(env, "CONCORDIA_AUTO_HANDOVER_WINDOW_TOKENS", DEFAULT_AUTO_HANDOVER_WINDOW_TOKENS, warn),
      thresholdPct: pct / 100,
    },
    repoAgents: {
      enabled: readFlag(env, "CONCORDIA_REPO_AGENTS", true),
      maxAgentsPerParent: readPositiveInt(env, "CONCORDIA_REPO_AGENTS_MAX", DEFAULT_REPO_AGENTS_MAX, warn),
      briefTimeoutSec: readPositiveInt(env, "CONCORDIA_REPO_AGENTS_BRIEF_TIMEOUT_SEC", DEFAULT_BRIEF_TIMEOUT_SEC, warn),
    },
    quietSec: readPositiveInt(env, "CONCORDIA_AUTO_SUCCESSION_QUIET_SEC", DEFAULT_QUIET_SEC, warn),
  };
}
