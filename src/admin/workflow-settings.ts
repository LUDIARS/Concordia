// 発火ユーザの allowlist はここには無い (社員名簿 staff_members へ移設)。
// 旧キー admin.reaction_workflow_{discord,slack}_users は migration 44 で名簿へ移行済み。
import type { SettingsStore } from "./settings-store.js";

const REACTION_ENABLED = "admin.reaction_workflow_enabled";
const CC_ENABLED = "admin.cc_workflow_enabled";
const EMOJI_OVERRIDES = "admin.reaction_emoji_overrides";
// セッション終了時に作業ブランチを Revisor の local PR として自動提出するか。
const REVISOR_AUTO_SUBMIT = "admin.revisor_auto_submit_enabled";
// 実装委託の初回 inject を調査ブリーフにし、 実装タスクを調査報告後に後追いで配るか。
const STAGED_INJECTION = "admin.delegation_staged_injection_enabled";

export interface WorkflowSettingsDefaults {
  reactionWorkflowEnabled?: boolean;
  ccWorkflowEnabled?: boolean;
  /** 既定 true。 レビュー発火が黙って無くなる状態を作らないため、 明示 OFF のみ止める。 */
  revisorAutoSubmitEnabled?: boolean;
  /** 既定 true (spec/feature/delegation-staged-injection.md)。 明示 OFF で従来の一括注入に戻る。 */
  delegationStagedInjectionEnabled?: boolean;
}

export class WorkflowSettingsStore {
  constructor(private readonly store: SettingsStore, private readonly defaults: WorkflowSettingsDefaults) {}

  getReactionEnabled(): boolean { return this.store.getBoolean(REACTION_ENABLED, this.defaults.reactionWorkflowEnabled ?? false); }
  setReactionEnabled(value: boolean): void { this.store.setBoolean(REACTION_ENABLED, value); }
  getCcEnabled(): boolean { return this.store.getBoolean(CC_ENABLED, this.defaults.ccWorkflowEnabled ?? false); }
  setCcEnabled(value: boolean): void { this.store.setBoolean(CC_ENABLED, value); }

  getRevisorAutoSubmitEnabled(): boolean { return this.store.getBoolean(REVISOR_AUTO_SUBMIT, this.defaults.revisorAutoSubmitEnabled ?? true); }
  setRevisorAutoSubmitEnabled(value: boolean): void { this.store.setBoolean(REVISOR_AUTO_SUBMIT, value); }

  /** 既定 true。 明示 OFF にすると実装委託の初回 inject が従来どおりタスク一括になる。 */
  getDelegationStagedInjectionEnabled(): boolean {
    return this.store.getBoolean(STAGED_INJECTION, this.defaults.delegationStagedInjectionEnabled ?? true);
  }
  setDelegationStagedInjectionEnabled(value: boolean): void { this.store.setBoolean(STAGED_INJECTION, value); }

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
}
