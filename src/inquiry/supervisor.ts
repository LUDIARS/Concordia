import type { DelegationRepo } from "../db/delegation-repo.js";

export interface Supervisor { platform: string; user_id: string; display_name: string | null; }

/** delegation run → template → config の優先順でお伺いの宛先を確定する。 */
export function resolveSupervisor(input: { delegation?: DelegationRepo; delegationRunId?: string | null; defaultSupervisor: string }): Supervisor | null {
  const run = input.delegationRunId && input.delegation ? input.delegation.findRun(input.delegationRunId) : null;
  const template = run?.template_id && input.delegation ? input.delegation.findTemplate(run.template_id) : null;
  const candidate = supervisorText(run?.supervisor_platform, run?.supervisor_user_id)
    ?? supervisorText(template?.supervisor_platform, template?.supervisor_user_id)
    ?? input.defaultSupervisor;
  const match = /^(discord|slack):([^:\s]+)$/.exec(candidate.trim());
  return match ? { platform: match[1]!, user_id: match[2]!, display_name: null } : null;
}

function supervisorText(platform: string | null | undefined, userId: string | null | undefined): string | null {
  return platform && userId ? `${platform}:${userId}` : null;
}
