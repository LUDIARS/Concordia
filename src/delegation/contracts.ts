import type {
  DelegationProvider,
  DelegationTemplateRow,
} from "../db/delegation-repo.js";
import type { DelegationRuntimeOptions } from "../control/provider-preset.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { EffortTaskBucket } from "./effort-policy.js";

export interface DelegationDefinition {
  template_id: string | null;
  call_name: string;
  title: string;
  target_provider: DelegationProvider;
  model: string | null;
  runtime_options_json?: string | null;
  prompt_template: string;
  input_schema: string;
  default_cwd: string | null;
  project?: string | null;
  emoji?: string | null;
}

export function templateToDefinition(tpl: DelegationTemplateRow): DelegationDefinition {
  return {
    template_id: tpl.id,
    call_name: tpl.call_name,
    title: tpl.title,
    target_provider: tpl.target_provider as DelegationProvider,
    model: tpl.model,
    runtime_options_json: tpl.runtime_options_json,
    prompt_template: tpl.prompt_template,
    input_schema: tpl.input_schema,
    default_cwd: tpl.default_cwd,
    project: tpl.project,
    emoji: tpl.emoji,
  };
}

export interface InvokeInput {
  call_name: string;
  args: Record<string, unknown>;
  cwd?: string;
  extra_prompt?: string;
  memory_links?: string[];
  triggered_by?: string;
  spawn?: boolean;
  options?: DelegationRuntimeOptions;
  overrides?: {
    provider?: DelegationProvider;
    model?: string | null;
    reasoning_effort?: string;
  };
  parent_session_id?: string | null;
  branch?: string;
  worktree?: boolean;
  subsidiary_id?: string | null;
  project?: string | null;
  requester_discord_user_id?: string | null;
  source_discord_guild_id?: string | null;
  source_discord_channel_id?: string | null;
  /** `/spawn` で選ばれた Memoria タスク。session.started まで pending claim で運ぶ。 */
  memoria_task_id?: number | null;
  memoria_task_title?: string | null;
}

export interface QueuePayload {
  def: DelegationDefinition;
  input: InvokeInput;
}

export type LaunchResult =
  | {
      ok: true;
      provider: DelegationProvider;
      status: DelegationRunRow["status"];
      spawn_pid: number | null;
      spawn_command: string[] | null;
      error_message: string | null;
      cwd: string | null;
      branch: string | null;
      worktree_path: string | null;
      worktree_created: boolean;
      effort_level: string | null;
      effort_source: string | null;
      effort_bucket: EffortTaskBucket | null;
      effective_model: string | null;
      fast_mode: boolean;
      effort_decision_id: number | null;
      /** 起票できた Memoria 追跡タスク (実装委託のみ)。 run 行へ焼く。 */
      memoria_task: { id: string; url: string } | null;
    }
  | { ok: false; error: string };
