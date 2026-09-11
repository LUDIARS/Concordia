import { isProjectNameInScope } from "../subsidiary/project-scope.js";
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

/**
 * CC-INV-06: HQ is unconditional; a subsidiary is fail-closed unless both its
 * project scope and the cached Revisor workflow prove eligibility.
 */
export function resolveDeploymentTargets(input: {
  project: string;
  hq: readonly DeployNotifyTarget[];
  projectTargets: readonly DeployNotifyTarget[];
  workflow: "revisor" | "github" | null | undefined;
  subsidiaries: readonly SubsidiaryDeploymentCandidate[];
}): { targets: SubsidiaryDeploymentTarget[]; hqCount: number; subsidiaryEligible: boolean } {
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

function uniqueTargets(targets: readonly SubsidiaryDeploymentTarget[]): SubsidiaryDeploymentTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.kind === "subsidiary-channel" ? `${target.kind}:${target.subsidiaryId}:${target.target}` : `${target.kind}:${target.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
