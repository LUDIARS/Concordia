import type Database from "better-sqlite3";
import { RuntimeSettingsStore, type LictorMode } from "./runtime-settings.js";
import { SqliteSettingsStore } from "./settings-store.js";
import { WorkflowSettingsStore, type WorkflowSettingsDefaults } from "./workflow-settings.js";
import { WorkspaceSettingsStore, type WorkspaceSettingsDefaults } from "./workspace-settings.js";

export type { LictorMode } from "./runtime-settings.js";

export interface AdminStateDefaults extends WorkspaceSettingsDefaults, WorkflowSettingsDefaults {
  lictorDevPath?: string;
}

/** Compatibility facade; domain policy lives in the three focused stores. */
export class AdminState {
  readonly workspace: WorkspaceSettingsStore;
  readonly workflow: WorkflowSettingsStore;
  readonly runtime: RuntimeSettingsStore;

  constructor(db: Database.Database, defaults: AdminStateDefaults = {}) {
    const store = new SqliteSettingsStore(db);
    this.workspace = new WorkspaceSettingsStore(store, defaults);
    this.workflow = new WorkflowSettingsStore(store, defaults);
    this.runtime = new RuntimeSettingsStore(store, defaults.lictorDevPath);
  }

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
  getReactionWorkflowDiscordUserIds(): string[] { return this.workflow.getDiscordUsers(); }
  setReactionWorkflowDiscordUserIds(ids: readonly string[]): void { this.workflow.setDiscordUsers(ids); }
  getReactionWorkflowSlackUserIds(): string[] { return this.workflow.getSlackUsers(); }
  setReactionWorkflowSlackUserIds(ids: readonly string[]): void { this.workflow.setSlackUsers(ids); }
  getRevisorAutoSubmitEnabled(): boolean { return this.workflow.getRevisorAutoSubmitEnabled(); }
  setRevisorAutoSubmitEnabled(value: boolean): void { this.workflow.setRevisorAutoSubmitEnabled(value); }
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
  getMentionUserId(): string | null { return this.runtime.getMentionUserId(); }
  setMentionUserId(value: string | null): void { this.runtime.setMentionUserId(value); }
  getCronJobOverrides(): Record<string, string> { return this.runtime.getCronJobOverrides(); }
  getCronJobOverride(jobName: string): string | null { return this.runtime.getCronJobOverride(jobName); }
  setCronJobOverride(jobName: string, callName: string | null): void { this.runtime.setCronJobOverride(jobName, callName); }

  snapshot() {
    return {
      chat_muted: this.getChatMuted(), rules_enabled: this.getRulesEnabled(),
      workspace_root: this.getWorkspaceRoot(), workspace_roots: this.getWorkspaceRoots(),
      github_org: this.getGithubOrg(), reaction_workflow_enabled: this.getReactionWorkflowEnabled(),
      cc_workflow_enabled: this.getCcWorkflowEnabled(),
      revisor_auto_submit_enabled: this.getRevisorAutoSubmitEnabled(), lictor_mode: this.getLictorMode(),
      lictor_dev_path: this.getLictorDevPath(), lictor_prod_exe: this.getLictorProdExe(),
      daily_token_budget: this.getDailyTokenBudget(), delegation_max_concurrency: this.getDelegationMaxConcurrency(),
      harness_strong_impl_models: this.getHarnessStrongImplModels(), mention_user_id: this.getMentionUserId(),
      cron_job_overrides: this.getCronJobOverrides(),
    };
  }
}
