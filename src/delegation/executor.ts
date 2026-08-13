import type { DelegationRepo, DelegationRunRow, RunSpawnOutcome } from "../db/delegation-repo.js";
import type { LaunchResult, QueuePayload } from "./contracts.js";
import { delegationQueueClaim } from "./lease.js";
import { emitDelegationRunChanged } from "./run-events.js";

export async function executeQueuedRun(input: {
  run: DelegationRunRow;
  repo: DelegationRepo;
  launch: (payload: QueuePayload) => Promise<LaunchResult>;
}): Promise<void> {
  const claim = delegationQueueClaim(input.run);
  const fail = (error: string): void => {
    const updated = input.repo.markRunSpawned(input.run.id, {
      status: "spawn_failed", spawn_pid: null, spawn_command: null, error,
    }, claim);
    emitDelegationRunChanged(updated);
  };
  if (!input.run.queue_payload_json) {
    fail("queue payload missing (起動入力が失われているため再実行できません)");
    return;
  }
  let payload: QueuePayload;
  try {
    payload = JSON.parse(input.run.queue_payload_json) as QueuePayload;
  } catch (error) {
    fail(`queue payload broken: ${(error as Error).message}`);
    return;
  }
  const launch = await input.launch(payload);
  if (!launch.ok) {
    fail(launch.error);
    return;
  }
  const outcome: RunSpawnOutcome = {
    status: launch.status,
    spawn_pid: launch.spawn_pid,
    spawn_command: launch.spawn_command,
    error: launch.error_message,
    effort_level: launch.effort_level,
    effort_source: launch.effort_source,
    effort_bucket: launch.effort_bucket,
    effective_model: launch.effective_model,
    fast_mode: launch.fast_mode,
    spawn_cwd: launch.cwd,
    spawn_branch: launch.branch,
    spawn_worktree_path: launch.worktree_path,
    spawn_worktree_created: launch.worktree_created,
    effort_decision_id: launch.effort_decision_id,
    staged_injection: launch.staged_injection,
  };
  emitDelegationRunChanged(input.repo.markRunSpawned(input.run.id, outcome, claim));
}
