import { spawnSession, type SpawnRequest } from "../control/spawner.js";
import {
  forgetPendingDelegationSpawnByRunId,
  recordPendingDelegationSpawn,
} from "../control/pending-delegation-spawns.js";
import {
  goalAndGoRequested,
  resolveDelegationRuntimeEnv,
  type DelegationRuntimeOptions,
} from "../control/provider-preset.js";
import type { DelegationProvider, DelegationRunRow } from "../db/delegation-repo.js";
import { createChildLogger } from "../shared/logger.js";
import type { DelegationDefinition, InvokeInput } from "./contracts.js";

const log = createChildLogger("delegation/launcher");

export type DelegationSpawner = (
  req: SpawnRequest,
) => { ok: true; pid: number | null; command: string[] } | { ok: false; error: string };

export function resolveDelegationSpawner(override?: DelegationSpawner): DelegationSpawner {
  return override ?? spawnSession;
}

export interface ProcessLaunchResult {
  status: DelegationRunRow["status"];
  spawnPid: number | null;
  spawnCommand: string[] | null;
  error: string | null;
}

export function launchDelegationProcess(input: {
  runId: string;
  definition: DelegationDefinition;
  invocation: InvokeInput;
  logicalProvider: DelegationProvider;
  spawnProvider: SpawnRequest["provider"];
  spawnArgs: string[];
  spawnEnv?: Record<string, string>;
  effectiveModel: string | null;
  effectiveOptions: DelegationRuntimeOptions;
  cwd?: string;
  branch: string | null;
  promptPath: string;
  startupInjectText: string;
  spawner?: DelegationSpawner;
}): ProcessLaunchResult {
  const spawner = resolveDelegationSpawner(input.spawner);
  const request: SpawnRequest = {
    provider: input.spawnProvider,
    mode: "window",
    cwd: input.cwd,
    args: input.spawnArgs.length > 0 ? input.spawnArgs : undefined,
    title: `delegation:${input.invocation.call_name}`,
    spawnId: input.runId,
    env: {
      ...(input.spawnEnv ?? {}),
      ...resolveDelegationRuntimeEnv(input.logicalProvider, input.effectiveOptions, input.effectiveModel),
      CONCORDIA_DELEGATION_PROMPT_FILE: input.promptPath,
      CONCORDIA_DELEGATION_RUN_ID: input.runId,
      ...(input.invocation.parent_session_id ? {
        CONCORDIA_DELEGATION_PARENT_SESSION_ID: input.invocation.parent_session_id,
        CONCORDIA_PARENT_SESSION_ID: input.invocation.parent_session_id,
      } : {}),
      CONCORDIA_DELEGATION_CALL_NAME: input.invocation.call_name,
    },
  };
  recordPendingDelegationSpawn({
    cwd: input.cwd,
    spawnId: input.runId,
    branch: input.branch,
    emoji: input.definition.emoji ?? null,
    callName: input.invocation.call_name,
    runId: input.runId,
    subsidiaryId: input.invocation.subsidiary_id ?? null,
    project: input.invocation.project ?? null,
    requesterDiscordUserId: input.invocation.requester_discord_user_id ?? null,
    startupInjectText: input.startupInjectText,
    sourceDiscordGuildId: input.invocation.source_discord_guild_id ?? null,
    sourceDiscordChannelId: input.invocation.source_discord_channel_id ?? null,
    parentSessionId: input.invocation.parent_session_id ?? null,
    goalAndGo: goalAndGoRequested(input.effectiveOptions),
    teamId: typeof input.effectiveOptions.team === "string" ? input.effectiveOptions.team : null,
  });
  const result = spawner(request);
  if (result.ok) {
    log.info({
      run_id: input.runId,
      call_name: input.invocation.call_name,
      provider: input.logicalProvider,
      cwd: input.cwd,
      spawn_pid: result.pid,
      prompt_file: input.promptPath,
    }, "delegation spawn ok");
    return { status: "spawned", spawnPid: result.pid, spawnCommand: result.command, error: null };
  }
  forgetPendingDelegationSpawnByRunId(input.runId);
  log.warn({
    run_id: input.runId,
    call_name: input.invocation.call_name,
    provider: input.logicalProvider,
    cwd: input.cwd,
    error: result.error,
  }, "delegation spawn failed");
  return { status: "spawn_failed", spawnPid: null, spawnCommand: null, error: result.error };
}
