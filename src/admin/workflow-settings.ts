// 発火ユーザの allowlist はここには無い (社員名簿 staff_members へ移設)。
// 旧キー admin.reaction_workflow_{discord,slack}_users は migration 44 で名簿へ移行済み。
import type { SettingsStore } from "./settings-store.js";
import { WORKFLOW_ACTION_POLICY_CAPABILITIES } from "../platform/reaction-workflow-capability.js";

const REACTION_ENABLED = "admin.reaction_workflow_enabled";
const CC_ENABLED = "admin.cc_workflow_enabled";
const EMOJI_OVERRIDES = "admin.reaction_emoji_overrides";
// アクション別ポリシー (子会社可否 / 要求権限の上書き)。2026-09-02 neco 指示。
const ACTION_POLICIES = "admin.reaction_action_policies";
// セッション終了時に作業ブランチを Revisor の local PR として自動提出するか。
const REVISOR_AUTO_SUBMIT = "admin.revisor_auto_submit_enabled";

export interface WorkflowSettingsDefaults {
  reactionWorkflowEnabled?: boolean;
  ccWorkflowEnabled?: boolean;
  /** 既定 true。 レビュー発火が黙って無くなる状態を作らないため、 明示 OFF のみ止める。 */
  revisorAutoSubmitEnabled?: boolean;
}

export class WorkflowSettingsStore {
  constructor(private readonly store: SettingsStore, private readonly defaults: WorkflowSettingsDefaults) {}

  getReactionEnabled(): boolean { return this.store.getBoolean(REACTION_ENABLED, this.defaults.reactionWorkflowEnabled ?? false); }
  setReactionEnabled(value: boolean): void { this.store.setBoolean(REACTION_ENABLED, value); }
  getCcEnabled(): boolean { return this.store.getBoolean(CC_ENABLED, this.defaults.ccWorkflowEnabled ?? false); }
  setCcEnabled(value: boolean): void { this.store.setBoolean(CC_ENABLED, value); }

  getRevisorAutoSubmitEnabled(): boolean { return this.store.getBoolean(REVISOR_AUTO_SUBMIT, this.defaults.revisorAutoSubmitEnabled ?? true); }
  setRevisorAutoSubmitEnabled(value: boolean): void { this.store.setBoolean(REVISOR_AUTO_SUBMIT, value); }

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

  /** アクション別ポリシー ({action: {subsidiary?, capability?}})。 壊れた保存値は空扱い。 */
  getActionPolicies(): Record<string, { subsidiary?: boolean; capability?: string }> {
    try {
      const parsed = JSON.parse(this.store.get(ACTION_POLICIES) ?? "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, { subsidiary?: boolean; capability?: string }> = {};
      for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as { subsidiary?: unknown; capability?: unknown };
        const policy: { subsidiary?: boolean; capability?: string } = {};
        if (typeof entry.subsidiary === "boolean") policy.subsidiary = entry.subsidiary;
        if (entry.capability === "none"
          || (typeof entry.capability === "string"
            && (WORKFLOW_ACTION_POLICY_CAPABILITIES as readonly string[]).includes(entry.capability))) {
          policy.capability = entry.capability;
        }
        if (Object.keys(policy).length > 0) out[action] = policy;
      }
      return out;
    } catch { return {}; }
  }

  /**
   * ポリシーを部分更新する。 undefined のフィールドは変更せず、 null は既定へ戻す。
   * 両フィールドとも既定になった action は行ごと消す (既定の重複保存を残さない)。
   */
  setActionPolicy(
    action: string,
    patch: { subsidiary?: boolean | null; capability?: string | null },
  ): void {
    const key = action.trim();
    if (!key) return;
    const policies = this.getActionPolicies();
    const current = { ...(policies[key] ?? {}) };
    if (patch.subsidiary !== undefined) {
      if (patch.subsidiary === null) delete current.subsidiary;
      else current.subsidiary = patch.subsidiary;
    }
    if (patch.capability !== undefined) {
      if (patch.capability === null) delete current.capability;
      else current.capability = patch.capability;
    }
    if (Object.keys(current).length === 0) delete policies[key];
    else policies[key] = current;
    this.store.set(ACTION_POLICIES, JSON.stringify(policies));
  }
}
