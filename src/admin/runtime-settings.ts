import type { SettingsStore } from "./settings-store.js";

const KEYS = {
  chatMuted: "admin.chat_muted", rulesEnabled: "admin.rules_enabled",
  lictorMode: "admin.lictor_mode", lictorDev: "admin.lictor_dev_path", lictorProd: "admin.lictor_prod_exe",
  dailyBudget: "admin.daily_token_budget", delegationMax: "admin.delegation_max_concurrency",
  strongModels: "harness.strong_impl_models", mentionUser: "admin.mention_user_id",
} as const;

export type LictorMode = "auto" | "dev" | "prod";

export class RuntimeSettingsStore {
  constructor(private readonly store: SettingsStore, private readonly lictorDevDefault = "") {}
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
  getMentionUserId(): string | null { return this.store.get(KEYS.mentionUser)?.trim() || null; }
  setMentionUserId(value: string | null): void { this.store.set(KEYS.mentionUser, value?.trim() ?? ""); }
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
