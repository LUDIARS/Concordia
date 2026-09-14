import { isProjectNameInScope } from "../subsidiary/project-scope.js";
import { isSubsidiaryInPolicyScope, type ProjectNotificationPolicy } from "./notification-target-policy.js";
import type { DeployNotifyTarget } from "./service-deployed.js";
import { contract } from "./ontime-runtime.js"; /* augur-inject:import:c4fcda6b */
import augurContract_72e64ad2 from "./service-deployed.contract.js"; /* augur-inject:contract-predicate:883b88b0 */

export interface SubsidiaryDeploymentTarget extends DeployNotifyTarget {
  subsidiaryId?: string;
  botTokenEnc?: string | null;
}

export interface SubsidiaryDeploymentCandidate {
  subsidiaryId: string;
  enabled: boolean;
  projects: readonly string[];
  kind: "discord" | "slack" | "subsidiary-channel";
  target: string;
  intakeChannelId: string | null;
  botTokenEnc: string | null;
}

export interface DeploymentTargetInput {
  project: string;
  hq: readonly DeployNotifyTarget[];
  projectTargets: readonly DeployNotifyTarget[];
  workflow: "revisor" | "github" | null | undefined;
  subsidiaries: readonly SubsidiaryDeploymentCandidate[];
  /** このイベントのプロジェクト別明示設定。 null / 省略は未設定で、現行の規則を使う。 */
  policy?: ProjectNotificationPolicy | null;
}

export interface DeploymentTargetResolution {
  targets: SubsidiaryDeploymentTarget[];
  hqCount: number;
  subsidiaryEligible: boolean;
}

/**
 * CC-INV-06 (未設定のプロジェクト): HQ is unconditional; a subsidiary is fail-closed unless both its
 * project scope and the cached Revisor workflow prove eligibility.
 * 明示設定のあるプロジェクトは利用者が選んだ範囲だけを使い、旧規則へ戻さない
 * (spec/feature/project-notification-preferences.md)。
 */
export function resolveDeploymentTargets(input: DeploymentTargetInput): DeploymentTargetResolution {
  if (input.policy) return resolveExplicitTargets(input, input.policy);
  const targets: SubsidiaryDeploymentTarget[] = [...input.hq, ...input.projectTargets];
  const subsidiaryEligible = input.workflow === "revisor";
  if (subsidiaryEligible) {
    for (const row of input.subsidiaries) {
      if (!row.enabled || !isProjectNameInScope(input.project, row.projects)) continue;
      if (row.kind === "subsidiary-channel") {
        const target = row.target || row.intakeChannelId || "";
        if (target && row.botTokenEnc) targets.push({ kind: "subsidiary-channel", target, subsidiaryId: row.subsidiaryId, botTokenEnc: row.botTokenEnc });
      } else targets.push({ kind: row.kind, target: row.target });
    }
  }
  return { targets: uniqueTargets(targets), hqCount: uniqueTargets(input.hq).length, subsidiaryEligible };
}

// @ts-expect-error augur-inject
resolveDeploymentTargets = contract(resolveDeploymentTargets, { ...augurContract_72e64ad2, contractId: "C-4", mode: "observe", sample: 1, where: "src/deploy/deployment-targets.ts:25", rule: "contract-wrap", id: "72e64ad2" }); /* augur-inject:contract-wrap:72e64ad2 */

/**
 * 明示設定の宛先。 範囲を選んだ利用者の設定を認可とみなし、Revisor workflow ミラーでは絞らない。
 * 無効は本社・追加宛先・子会社のすべてを止める。 子会社 Bot 未設定の子会社チャンネルも残し、
 * 配送時に本社 Bot へ倒す (`resolveSubsidiaryBotToken`) — 未設定の子会社へ黙って届かない状態を作らない。
 */
function resolveExplicitTargets(input: DeploymentTargetInput, policy: ProjectNotificationPolicy): DeploymentTargetResolution {
  if (!policy.enabled) return { targets: [], hqCount: 0, subsidiaryEligible: false };
  const hq = policy.hq ? input.hq : [];
  const targets: SubsidiaryDeploymentTarget[] = [...hq, ...input.projectTargets];
  for (const row of input.subsidiaries) {
    if (!isSubsidiaryInPolicyScope(policy, input.project, row)) continue;
    if (row.kind !== "subsidiary-channel") {
      targets.push({ kind: row.kind, target: row.target });
      continue;
    }
    const target = row.target || row.intakeChannelId || "";
    if (target) targets.push({ kind: "subsidiary-channel", target, subsidiaryId: row.subsidiaryId, botTokenEnc: row.botTokenEnc });
  }
  return { targets: uniqueTargets(targets), hqCount: uniqueTargets(hq).length, subsidiaryEligible: policy.subsidiaryScope !== "none" };
}

function uniqueTargets(targets: readonly SubsidiaryDeploymentTarget[]): SubsidiaryDeploymentTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.kind === "subsidiary-channel" ? `${target.kind}:${target.subsidiaryId}:${target.target}` : `${target.kind}:${target.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
