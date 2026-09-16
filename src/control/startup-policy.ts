// @spec 初期ポリシーの版と照合
import { createHash } from "node:crypto";
import { buildSessionWorkPolicy, type SessionWorkPolicyInput } from "./session-work-policy.js";
import { buildSharedStartupContext } from "./shared-startup-context.js";
import { buildProcessGuidance } from "./process-guidance.js";
import type { StartupRequirements } from "./startup-policy-requirements.js";
export type { StartupRequirements } from "./startup-policy-requirements.js";

export interface StartupPolicySnapshot {
  revision: string;
  fields: Record<string, string>;
  text: string;
  delivery: "scheduled" | "queued";
}
export const STARTUP_POLICY_KEY = "cc_startup_policy";

export async function buildStartupPolicy(input: SessionWorkPolicyInput & {
  provider: string; repoOrigin?: string | null; projectRoot?: string; projectCode?: string; requirements: StartupRequirements | null;
}): Promise<{ policy: StartupPolicySnapshot; registeredBranch: string | null; branchMismatch: boolean }> {
  const work = buildSessionWorkPolicy(input);
  const required = input.requirements;
  const fields = {
    rules: "startup-policy-v3-workflow-at-push",
    repo: input.repoPath, branch: input.observedBranch ?? "unknown", provider: input.provider,
    origin: input.repoOrigin ?? "unknown",
    projectRoot: input.projectRoot ?? "unknown",
    projectCode: input.projectCode ?? "unknown",
    requestedBranch: input.pendingSpawn?.branch ?? "",
    requirements: required ? `DDD=${required.ddd}; tests=${required.tests}; ontime=${required.ontime}; workContract=${required.workContract}` : "unknown",
    workPolicy: work.text,
    process: buildProcessGuidance(required, input.projectRoot) ?? "",
    resources: await buildSharedStartupContext(input),
  };
  const revision = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  const process = fields.process ? `\n${fields.process}\n` : "";
  const text = `${work.text}\n- Cc 構成: ${fields.requirements}\n- 必須設定は実装の受入条件です。テスト・起動・デプロイの実行許可を追加しません。\n${process}\n${fields.resources}\n[Cc policy revision: ${revision}]`;
  return { ...work, policy: { revision, fields, text, delivery: "queued" } };
}

export function startupPolicyDelta(previous: StartupPolicySnapshot | null, next: StartupPolicySnapshot): string | null {
  if (previous?.revision === next.revision) return null;
  if (!previous || previous.delivery === "scheduled") return next.text;
  const changed = Object.entries(next.fields).filter(([key, value]) => previous.fields[key] !== value);
  const withdrawal = Object.hasOwn(previous.fields, "workflow")
    ? "過去の起動案内に含まれるワークフロー判定・提出手順は無効です。push 検討時のフックで現在の対象設定を確認してください。\n"
    : "";
  return `[Cc policy update]\n${withdrawal}${changed.map(([key, value]) => `${key}: ${value}`).join("\n")}\n必須設定は実行許可を追加しません。\n[Cc policy revision: ${next.revision}]`;
}

export function readStartupPolicy(metadata: string | null): StartupPolicySnapshot | null {
  try {
    const value = JSON.parse(metadata ?? "{}")[STARTUP_POLICY_KEY];
    return value && typeof value.revision === "string" && typeof value.text === "string"
      && value.fields && typeof value.fields === "object" ? value : null;
  } catch { return null; }
}
