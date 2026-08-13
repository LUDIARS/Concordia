import {
  DEFAULT_MAIN_PUSH_ALLOWLIST,
  MAIN_PUSH_ALLOWLIST_ENV,
  parseMainPushAllowlist,
} from "../harness/main-push-allowlist.js";
import type { SettingsStore } from "./settings-store.js";

const KEYS = {
  chatMuted: "admin.chat_muted", rulesEnabled: "admin.rules_enabled",
  lictorMode: "admin.lictor_mode", lictorDev: "admin.lictor_dev_path", lictorProd: "admin.lictor_prod_exe",
  dailyBudget: "admin.daily_token_budget", delegationMax: "admin.delegation_max_concurrency",
  strongModels: "harness.strong_impl_models", mentionUser: "admin.mention_user_id",
  mainPushAllowlist: "harness.main_push_allowlist",
  cronJobOverrides: "admin.cron_job_overrides",
  watchdogEnabled: "admin.delegation_watchdog_enabled",
  watchdogIdleSec: "admin.delegation_watchdog_idle_sec",
  watchdogMaxNudges: "admin.delegation_watchdog_max_nudges",
  reaperSessionEndGraceSec: "admin.reaper_session_end_grace_sec",
  thinkingMessages: "admin.thinking_messages_enabled",
} as const;

export type LictorMode = "auto" | "dev" | "prod";

export class RuntimeSettingsStore {
  constructor(
    private readonly store: SettingsStore,
    private readonly lictorDevDefault = "",
    private readonly reaperSessionEndGraceDefault = 300,
  ) {}
  getChatMuted(): boolean { return this.store.getBoolean(KEYS.chatMuted, true); }
  setChatMuted(value: boolean): void { this.store.setBoolean(KEYS.chatMuted, value); }
  getRulesEnabled(): boolean { return this.store.getBoolean(KEYS.rulesEnabled, false); }
  setRulesEnabled(value: boolean): void { this.store.setBoolean(KEYS.rulesEnabled, value); }
  getLictorMode(): LictorMode {
    const value = this.store.get(KEYS.lictorMode);
    return value === "dev" || value === "prod" ? value : "auto";
  }
  setLictorMode(value: string): void {
    if (value !== "auto" && value !== "dev" && value !== "prod") throw new Error("lictor_mode must be one of auto / dev / prod");
    this.store.set(KEYS.lictorMode, value);
  }
  getLictorDevPath(): string { return this.store.get(KEYS.lictorDev)?.trim() || this.lictorDevDefault; }
  setLictorDevPath(value: string): void { this.store.set(KEYS.lictorDev, value.trim()); }
  getLictorProdExe(): string { return this.store.get(KEYS.lictorProd) ?? ""; }
  setLictorProdExe(value: string): void { this.store.set(KEYS.lictorProd, value.trim()); }
  getDailyTokenBudget(): number { return positiveOrZero(this.store.get(KEYS.dailyBudget), 0); }
  setDailyTokenBudget(value: number): void { this.store.set(KEYS.dailyBudget, String(requireNonNegative(value, "daily_token_budget"))); }
  getDelegationMaxConcurrency(): number { return positiveOrZero(this.store.get(KEYS.delegationMax), 4); }
  setDelegationMaxConcurrency(value: number): void { this.store.set(KEYS.delegationMax, String(requireNonNegative(value, "delegation_max_concurrency"))); }
  getHarnessStrongImplModels(): string[] {
    try {
      const parsed = JSON.parse(this.store.get(KEYS.strongModels) ?? "[]") as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter((item): item is string => typeof item === "string" && !!item.trim());
    } catch { /* use defaults */ }
    return ["fable", "sol-ultra"];
  }
  setHarnessStrongImplModels(models: string[]): void { this.store.set(KEYS.strongModels, JSON.stringify(models.map((model) => model.trim()).filter(Boolean))); }
  /**
   * main 直 push を許可するリポ (MELPOT 例外)。 解決順は 設定 (WebUI) → env
   * {@link MAIN_PUSH_ALLOWLIST_ENV} → 既定シード。 設定に空配列を保存した場合は
   * 「例外なし」の明示指定として尊重する (env / 既定へフォールバックしない)。
   */
  getHarnessMainPushAllowlist(): string[] {
    const raw = this.store.get(KEYS.mainPushAllowlist);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
        return parsed.map((item) => item.trim()).filter(Boolean);
      } catch {
        // 明示設定の破損時に既定例外を有効化しない (fail-closed)。
        return [];
      }
    }
    return parseMainPushAllowlist(process.env[MAIN_PUSH_ALLOWLIST_ENV]) ?? [...DEFAULT_MAIN_PUSH_ALLOWLIST];
  }
  getMentionUserId(): string | null { return this.store.get(KEYS.mentionUser)?.trim() || null; }
  setMentionUserId(value: string | null): void { this.store.set(KEYS.mentionUser, value?.trim() ?? ""); }
  // 委託 run watchdog (spec/tasks/2026-08-08-delegation-run-watchdog.md)。
  getDelegationWatchdogEnabled(): boolean { return this.store.getBoolean(KEYS.watchdogEnabled, true); }
  setDelegationWatchdogEnabled(value: boolean): void { this.store.setBoolean(KEYS.watchdogEnabled, value); }
  getDelegationWatchdogIdleSec(): number { return positiveOrDefault(this.store.get(KEYS.watchdogIdleSec), 1800); }
  setDelegationWatchdogIdleSec(value: number): void { this.store.set(KEYS.watchdogIdleSec, String(requirePositive(value, "delegation_watchdog_idle_sec"))); }
  getDelegationWatchdogMaxNudges(): number { return positiveOrDefault(this.store.get(KEYS.watchdogMaxNudges), 3); }
  setDelegationWatchdogMaxNudges(value: number): void { this.store.set(KEYS.watchdogMaxNudges, String(requirePositive(value, "delegation_watchdog_max_nudges"))); }
  getReaperSessionEndGraceSec(): number { return positiveOrDefault(this.store.get(KEYS.reaperSessionEndGraceSec), this.reaperSessionEndGraceDefault); }
  setReaperSessionEndGraceSec(value: number): void { this.store.set(KEYS.reaperSessionEndGraceSec, String(requirePositive(value, "reaper_session_end_grace_sec"))); }
  /**
   * assistant の thinking を session_messages に流すか (既定 OFF — 2026-08-12 neco 指示:
   * 中継面に thinking が出るのは不要なことが多い)。 解決順は DB (WebUI 設定) → env → 既定。
   */
  getThinkingMessagesEnabled(): boolean {
    const raw = this.store.get(KEYS.thinkingMessages);
    if (raw !== null && raw.trim() !== "") return raw === "1" || raw === "true";
    const env = process.env.CONCORDIA_THINKING_MESSAGES_ENABLED?.trim();
    if (env !== undefined && env !== "") return env === "1" || env === "true";
    return false;
  }
  setThinkingMessagesEnabled(value: boolean): void { this.store.setBoolean(KEYS.thinkingMessages, value); }

  /**
   * 内部 cron (src/scheduler/cron-jobs.ts) の call_name を、コード再デプロイなしで
   * WebUI から切り替えるための override。 job_name → call_name の map。
   * 未設定/null 相当のキーは削除し、cron-jobs.ts の既定 call_name を使わせる。
   */
  getCronJobOverrides(): Record<string, string> {
    try {
      const parsed = JSON.parse(this.store.get(KEYS.cronJobOverrides) ?? "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [jobName, callName] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof callName === "string" && callName.trim()) out[jobName] = callName.trim();
        }
        return out;
      }
    } catch { /* treat as unset */ }
    return {};
  }
  getCronJobOverride(jobName: string): string | null {
    return this.getCronJobOverrides()[jobName] ?? null;
  }
  setCronJobOverride(jobName: string, callName: string | null): void {
    const overrides = this.getCronJobOverrides();
    if (callName === null || !callName.trim()) delete overrides[jobName];
    else overrides[jobName] = callName.trim();
    this.store.set(KEYS.cronJobOverrides, JSON.stringify(overrides));
  }
}

function positiveOrZero(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function requireNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return Math.max(0, Math.floor(value));
}
function positiveOrDefault(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive number`);
  return Math.floor(value);
}
