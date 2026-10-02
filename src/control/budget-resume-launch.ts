/**
 * 予算切れで中断したセッションを `claude --resume <会話 id>` で起動し直す起動指示を組み立てる
 * (spec/feature/usage-budgets.md §5.3、 2026-10-02 neco 指示「いわゆる -resume です」)。
 *
 * - 同じ作業ディレクトリ (会話を始めた場所)・同じテンプレート・同じ部署・同じチーム・同じ依頼者で起動する。
 * - モデルと effort は中断したセッションが記録していたものを渡す (resume は会話だけを引き継ぐため)。
 * - プロジェクトを持たない相談部署なら、 相談専用の Claude 設定フォルダとツール制限を同じに付ける
 *   (会話はその設定フォルダの中にあるので、 外すと見つからない)。
 * - 初回指示は渡さない (会話の続きから再開する)。
 *
 * 純関数のみ。 起動 (spawn) と保留登録は呼び出し側。
 *
 * @implements SPEC-USAGE-BUDGET-SUSPEND
 */

import type { SessionRow } from "../shared/types.js";
import type { SpawnRequest } from "./spawner.js";
import { resolveDelegationRuntimeArgs } from "./provider-preset.js";
import {
  CONSULT_SESSION_ENV,
  PROJECTLESS_CONSULT_CLAUDE_ARGS,
  consultClaudeConfigDir,
  consultPersonalDataDir,
} from "../consultation/projectless-consult.js";

export interface BudgetResumeLaunchInput {
  session: Pick<SessionRow, "id" | "provider" | "metadata" | "team_id" | "department_id">;
  conversationId: string;
  cwd: string;
  /** 中断したセッションがプロジェクトを持たない相談部署なら、 相談用ディレクトリの置き場所。 */
  consultWorkspaceRoot: string | null;
}

/** recordPendingDelegationSpawn へ渡す、 起動し直したセッションの帰属。 */
export interface BudgetResumePending {
  cwd: string;
  callName: string;
  subsidiaryId: string | null;
  project: string | null;
  requesterDiscordUserId: string | null;
  sourceDiscordGuildId: string | null;
  sourceDiscordChannelId: string | null;
  teamId: string | null;
  departmentId: string | null;
}

export type BudgetResumeLaunchPlan =
  | { ok: true; spawn: Omit<SpawnRequest, "spawnId">; pending: BudgetResumePending }
  | { ok: false; error: string };

/** テンプレートを持たない起動を再開したときの呼び名。 */
export const BUDGET_RESUME_CALL_NAME = "budget-resume";

function text(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function planBudgetResumeLaunch(input: BudgetResumeLaunchInput): BudgetResumeLaunchPlan {
  if (input.session.provider !== "claude-code") return { ok: false, error: "resume_requires_claude" };
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = input.session.metadata ? JSON.parse(input.session.metadata) as unknown : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "session_metadata_invalid" };
  }
  const model = text(metadata, "model");
  const effort = text(metadata, "effort");
  const requester = text(metadata, "discord_requester_user_id");
  const consultRoot = input.consultWorkspaceRoot;
  const dataDir = consultRoot ? consultPersonalDataDir(input.cwd, requester) : null;
  const args = [
    "--resume", input.conversationId,
    ...(model ? ["--model", model] : []),
    ...resolveDelegationRuntimeArgs("claude", effort ? { effort } : {}),
    ...(consultRoot ? PROJECTLESS_CONSULT_CLAUDE_ARGS : []),
  ];
  const env: Record<string, string> = consultRoot
    ? {
      ...CONSULT_SESSION_ENV,
      CLAUDE_CONFIG_DIR: consultClaudeConfigDir(consultRoot),
      ...(dataDir ? { CONCORDIA_CONSULT_DATA_DIR: dataDir } : {}),
    }
    : {};
  const teamId = input.session.team_id ?? null;
  if (teamId) env.CONCORDIA_TEAM_ID = teamId;
  return {
    ok: true,
    spawn: {
      provider: "claude",
      mode: "tab",
      args,
      cwd: input.cwd,
      cwdProvided: true,
      title: `resume:${input.session.id.slice(0, 16)}`,
      env,
    },
    pending: {
      cwd: input.cwd,
      callName: text(metadata, "delegation_call_name") ?? BUDGET_RESUME_CALL_NAME,
      subsidiaryId: text(metadata, "subsidiary_id"),
      project: text(metadata, "project"),
      requesterDiscordUserId: requester,
      sourceDiscordGuildId: text(metadata, "discord_source_guild_id"),
      sourceDiscordChannelId: text(metadata, "discord_source_channel_id"),
      teamId,
      departmentId: input.session.department_id ?? null,
    },
  };
}
