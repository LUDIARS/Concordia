import type {
  DelegationCategory,
  DelegationProvider,
  DelegationTemplateRow,
} from "../db/delegation-repo.js";
import type { DelegationRuntimeOptions } from "../control/provider-preset.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { EffortTaskBucket } from "./effort-policy.js";
import type { SpawnWorktreeState } from "../control/spawn-target.js";

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
  /**
   * 雇用形態カテゴリ。 inject の書式 (実装委託 / パートタイマー) を分ける唯一の判定材料
   * なので definition まで運ぶ。 語のヒューリスティックでは「メール監視」を実装委託と
   * 誤判定して詰む (delegation/parttimer-inject.ts 冒頭)。
   */
  category?: DelegationCategory | null;
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
    category: tpl.category,
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
  /** /v1/delegation/invoke が parent session contract から解決した branch。 */
  contract_branch?: string;
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
  /** run 作成時刻。queued 後も子 env と完了証跡の --since を同じ起点にする。 */
  startedAt?: number;
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
      /** worktree 解決の結果状態。 監視で事故 (共有 checkout 着地) を拾うための観測点。 */
      worktree_state: SpawnWorktreeState | null;
      effort_level: string | null;
      effort_source: string | null;
      effort_bucket: EffortTaskBucket | null;
      effective_model: string | null;
      fast_mode: boolean;
      effort_decision_id: number | null;
      /** 起票できた Memoria 追跡タスク (実装委託のみ)。 run 行へ焼く。 */
      memoria_task: { id: string; url: string } | null;
      /** prompt へ本文同梱した別リポ md (`<project>:<repo-relative-path>`)。 run 行へ焼く。 */
      bundled_docs: string[];
    }
  | { ok: false; error: string };
