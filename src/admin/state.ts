import type Database from "better-sqlite3";
import { RuntimeSettingsStore, type LictorMode } from "./runtime-settings.js";
import { EncryptedSettingsStore, SqliteSettingsStore, type SettingsStore } from "./settings-store.js";
import type { SecretBox } from "../shared/secret-box.js";
import { WorkflowSettingsStore, type WorkflowSettingsDefaults } from "./workflow-settings.js";
import { WorkspaceSettingsStore, type WorkspaceSettingsDefaults } from "./workspace-settings.js";
import { WorkflowToggles } from "../workflow/toggles.js";
import type { WorkflowKey } from "../workflow/keys.js";

export type { LictorMode } from "./runtime-settings.js";

export interface AdminStateDefaults extends WorkspaceSettingsDefaults, WorkflowSettingsDefaults {
  lictorDevPath?: string;
  reaperSessionEndGraceSec?: number;
}

/** Compatibility facade; domain policy lives in the three focused stores. */
export class AdminState {
  readonly workspace: WorkspaceSettingsStore;
  readonly workflow: WorkflowSettingsStore;
  readonly runtime: RuntimeSettingsStore;
  /** ワークフロー個別有効化フラグ (DB → env → 既定 true)。 値は都度解決。 */
  readonly workflows: WorkflowToggles;
  /**
   * schema_meta の素の key/value 口。 設定レジストリ (config/settings) が
   * キー単位の汎用読み書きに使う。 意味付けは上の 3 ストアが持つ。
   */
  readonly store: SettingsStore;

  constructor(db: Database.Database, defaults: AdminStateDefaults = {}, secretBox?: SecretBox) {
    const rawStore = new SqliteSettingsStore(db);
    const store: SettingsStore = secretBox ? new EncryptedSettingsStore(rawStore, secretBox) : rawStore;
    this.store = store;
    this.workspace = new WorkspaceSettingsStore(store, defaults);
    this.workflow = new WorkflowSettingsStore(store, defaults);
    this.runtime = new RuntimeSettingsStore(store, defaults.lictorDevPath, defaults.reaperSessionEndGraceSec);
    this.workflows = new WorkflowToggles({ store });
  }

  isWorkflowEnabled(key: WorkflowKey): boolean { return this.workflows.isEnabled(key); }
  setWorkflowEnabled(key: WorkflowKey, value: boolean): void { this.workflows.setEnabled(key, value); }

  getChatMuted(): boolean { return this.runtime.getChatMuted(); }
  setChatMuted(value: boolean): void { this.runtime.setChatMuted(value); }
  getRulesEnabled(): boolean { return this.runtime.getRulesEnabled(); }
  setRulesEnabled(value: boolean): void { this.runtime.setRulesEnabled(value); }
  getWorkspaceRoots(): string[] { return this.workspace.getRoots(); }
  getWorkspaceRoot(): string { return this.workspace.getPrimaryRoot(); }
  setWorkspaceRoots(values: string[]): void { this.workspace.setRoots(values); }
  setWorkspaceRoot(value: string): void { this.workspace.setPrimaryRoot(value); }
  getGithubOrg(): string { return this.workspace.getGithubOrg(); }
  setGithubOrg(value: string): void { this.workspace.setGithubOrg(value); }
  getReactionWorkflowEnabled(): boolean { return this.workflow.getReactionEnabled(); }
  setReactionWorkflowEnabled(value: boolean): void { this.workflow.setReactionEnabled(value); }
  // 発火ユーザの allowlist は撤去済み (社員名簿 staff_members が判定の正本)。
  getRevisorAutoSubmitEnabled(): boolean { return this.workflow.getRevisorAutoSubmitEnabled(); }
  setRevisorAutoSubmitEnabled(value: boolean): void { this.workflow.setRevisorAutoSubmitEnabled(value); }
  getDelegationStagedInjectionEnabled(): boolean { return this.workflow.getDelegationStagedInjectionEnabled(); }
  setDelegationStagedInjectionEnabled(value: boolean): void { this.workflow.setDelegationStagedInjectionEnabled(value); }
  getCcWorkflowEnabled(): boolean { return this.workflow.getCcEnabled(); }
  setCcWorkflowEnabled(value: boolean): void { this.workflow.setCcEnabled(value); }
  getReactionEmojiOverrides(): Record<string, string> { return this.workflow.getEmojiOverrides(); }
  setReactionEmojiOverride(emoji: string, action: string): void { this.workflow.setEmojiOverride(emoji, action); }
  deleteReactionEmojiOverride(emoji: string): void { this.workflow.deleteEmojiOverride(emoji); }
  getLictorMode(): LictorMode { return this.runtime.getLictorMode(); }
  setLictorMode(value: string): void { this.runtime.setLictorMode(value); }
  getLictorDevPath(): string { return this.runtime.getLictorDevPath(); }
  setLictorDevPath(value: string): void { this.runtime.setLictorDevPath(value); }
  getLictorProdExe(): string { return this.runtime.getLictorProdExe(); }
  setLictorProdExe(value: string): void { this.runtime.setLictorProdExe(value); }
  getDailyTokenBudget(): number { return this.runtime.getDailyTokenBudget(); }
  setDailyTokenBudget(value: number): void { this.runtime.setDailyTokenBudget(value); }
  getDelegationMaxConcurrency(): number { return this.runtime.getDelegationMaxConcurrency(); }
  setDelegationMaxConcurrency(value: number): void { this.runtime.setDelegationMaxConcurrency(value); }
  getHarnessStrongImplModels(): string[] { return this.runtime.getHarnessStrongImplModels(); }
  setHarnessStrongImplModels(models: string[]): void { this.runtime.setHarnessStrongImplModels(models); }
  getHarnessMainPushAllowlist(): string[] { return this.runtime.getHarnessMainPushAllowlist(); }
  getMentionUserId(): string | null { return this.runtime.getMentionUserId(); }
  setMentionUserId(value: string | null): void { this.runtime.setMentionUserId(value); }
  getDelegationWatchdogEnabled(): boolean { return this.runtime.getDelegationWatchdogEnabled(); }
  setDelegationWatchdogEnabled(value: boolean): void { this.runtime.setDelegationWatchdogEnabled(value); }
  getDelegationWatchdogIdleSec(): number { return this.runtime.getDelegationWatchdogIdleSec(); }
  setDelegationWatchdogIdleSec(value: number): void { this.runtime.setDelegationWatchdogIdleSec(value); }
  getDelegationWatchdogMaxNudges(): number { return this.runtime.getDelegationWatchdogMaxNudges(); }
  setDelegationWatchdogMaxNudges(value: number): void { this.runtime.setDelegationWatchdogMaxNudges(value); }
  getReaperSessionEndGraceSec(): number { return this.runtime.getReaperSessionEndGraceSec(); }
  setReaperSessionEndGraceSec(value: number): void { this.runtime.setReaperSessionEndGraceSec(value); }
  getThinkingMessagesEnabled(): boolean { return this.runtime.getThinkingMessagesEnabled(); }
  setThinkingMessagesEnabled(value: boolean): void { this.runtime.setThinkingMessagesEnabled(value); }
  getCronJobOverrides(): Record<string, string> { return this.runtime.getCronJobOverrides(); }
  getCronJobOverride(jobName: string): string | null { return this.runtime.getCronJobOverride(jobName); }
  setCronJobOverride(jobName: string, callName: string | null): void { this.runtime.setCronJobOverride(jobName, callName); }
  migrateCronJobOverride(oldJobName: string, newJobName: string, oldDefaultCallName: string, newDefaultCallName: string): void {
    this.runtime.migrateCronJobOverride(oldJobName, newJobName, oldDefaultCallName, newDefaultCallName);
  }

  snapshot() {
    return {
      chat_muted: this.getChatMuted(), rules_enabled: this.getRulesEnabled(),
      workspace_root: this.getWorkspaceRoot(), workspace_roots: this.getWorkspaceRoots(),
      github_org: this.getGithubOrg(), reaction_workflow_enabled: this.getReactionWorkflowEnabled(),
      cc_workflow_enabled: this.getCcWorkflowEnabled(),
      revisor_auto_submit_enabled: this.getRevisorAutoSubmitEnabled(),
      delegation_staged_injection_enabled: this.getDelegationStagedInjectionEnabled(),
      lictor_mode: this.getLictorMode(),
      lictor_dev_path: this.getLictorDevPath(), lictor_prod_exe: this.getLictorProdExe(),
      daily_token_budget: this.getDailyTokenBudget(), delegation_max_concurrency: this.getDelegationMaxConcurrency(),
      harness_strong_impl_models: this.getHarnessStrongImplModels(), mention_user_id: this.getMentionUserId(),
      harness_main_push_allowlist: this.getHarnessMainPushAllowlist(),
      cron_job_overrides: this.getCronJobOverrides(),
      delegation_watchdog_enabled: this.getDelegationWatchdogEnabled(),
      delegation_watchdog_idle_sec: this.getDelegationWatchdogIdleSec(),
      delegation_watchdog_max_nudges: this.getDelegationWatchdogMaxNudges(),
      reaper_session_end_grace_sec: this.getReaperSessionEndGraceSec(),
      workflows: this.workflows.snapshot(),
    };
  }
}
