import { normalizeReactionUserIds } from "../shared/reaction-workflow-auth.js";
import type { SettingsStore } from "./settings-store.js";

const REACTION_ENABLED = "admin.reaction_workflow_enabled";
const DISCORD_USERS = "admin.reaction_workflow_discord_users";
const SLACK_USERS = "admin.reaction_workflow_slack_users";
const CC_ENABLED = "admin.cc_workflow_enabled";
const EMOJI_OVERRIDES = "admin.reaction_emoji_overrides";

export interface WorkflowSettingsDefaults {
  reactionWorkflowEnabled?: boolean;
  reactionWorkflowDiscordUserIds?: string[];
  reactionWorkflowSlackUserIds?: string[];
  ccWorkflowEnabled?: boolean;
}

export class WorkflowSettingsStore {
  constructor(private readonly store: SettingsStore, private readonly defaults: WorkflowSettingsDefaults) {}

  getReactionEnabled(): boolean { return this.store.getBoolean(REACTION_ENABLED, this.defaults.reactionWorkflowEnabled ?? false); }
  setReactionEnabled(value: boolean): void { this.store.setBoolean(REACTION_ENABLED, value); }
  getCcEnabled(): boolean { return this.store.getBoolean(CC_ENABLED, this.defaults.ccWorkflowEnabled ?? false); }
  setCcEnabled(value: boolean): void { this.store.setBoolean(CC_ENABLED, value); }
  getDiscordUsers(): string[] { return this.getUsers(DISCORD_USERS, this.defaults.reactionWorkflowDiscordUserIds); }
  setDiscordUsers(ids: readonly string[]): void { this.setUsers(DISCORD_USERS, ids); }
  getSlackUsers(): string[] { return this.getUsers(SLACK_USERS, this.defaults.reactionWorkflowSlackUserIds); }
  setSlackUsers(ids: readonly string[]): void { this.setUsers(SLACK_USERS, ids); }

  getEmojiOverrides(): Record<string, string> {
    try {
      const parsed = JSON.parse(this.store.get(EMOJI_OVERRIDES) ?? "{}") as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch { return {}; }
  }
  setEmojiOverride(emoji: string, action: string): void {
    const key = emoji.trim();
    if (!key) return;
    this.store.set(EMOJI_OVERRIDES, JSON.stringify({ ...this.getEmojiOverrides(), [key]: action }));
  }
  deleteEmojiOverride(emoji: string): void {
    const overrides = this.getEmojiOverrides();
    const key = emoji.trim();
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) return;
    delete overrides[key];
    this.store.set(EMOJI_OVERRIDES, JSON.stringify(overrides));
  }

  private getUsers(key: string, fallback?: readonly string[]): string[] {
    const raw = this.store.get(key);
    if (raw === null) return normalizeReactionUserIds(fallback);
    try {
      const value = JSON.parse(raw) as unknown;
      return normalizeReactionUserIds(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback);
    } catch { return normalizeReactionUserIds(fallback); }
  }
  private setUsers(key: string, ids: readonly string[]): void {
    this.store.set(key, JSON.stringify(normalizeReactionUserIds(ids)));
  }
}
