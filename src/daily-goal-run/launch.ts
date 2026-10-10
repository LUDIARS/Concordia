/**
 * 起動の use case: 期限が来たゴールの起動、 結果不明の照合、 専用セッションの紐付け。
 *
 * @implements spec/feature/daily-goal-run.md — 3. 専用セッションを起動する / CC-DG-INV-01 / CC-DG-INV-02 / CC-INV-03
 *
 * 起動の intent (run id) を先に保存してから invoke する。 結果不明は run 台帳と照合し、
 * 見つかるまで再 invoke しない。 喪失したセッションの代わりは自動で起動しない。
 */

import { randomUUID } from "node:crypto";
import { isDue } from "./launch-policy.js";
import { describePermissions } from "./prompts.js";
import { bindGoalToMetadata } from "./session-binding.js";
import type { DailyGoal } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

export const DAILY_GOAL_RUNNER_CALL_NAME = "daily-goal-runner";
/** 起動が失敗と確定したときの再試行までの待ち。 */
export const LAUNCH_RETRY_MS = 10 * 60_000;

export function runnerArgs(goal: DailyGoal, baseUrl: string): Record<string, string> {
  return {
    daily_goal_id: goal.id,
    target_repo: goal.repoPath,
    goal_text: goal.goalText,
    acceptance: goal.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    permissions: describePermissions(goal.permissions),
    actio_tasks: goal.actioTaskIds.map((id) => `actio:${id}`).join(", "),
    concordia_url: baseUrl,
  };
}

export class DailyGoalLauncher {
  constructor(private readonly deps: DailyGoalServiceDeps, private readonly touch: (goalId: string, line?: string) => void) {}

  /** 期限が来た confirmed ゴールを起動する。 */
  async launchDue(now: number): Promise<void> {
    const { launchTime } = this.deps.config();
    for (const goal of this.deps.repo.listByStatus(["confirmed"])) {
      if (isDue(goal, now, launchTime)) await this.launch(goal, now);
    }
  }

  private async launch(goal: DailyGoal, now: number): Promise<void> {
    const runId = (this.deps.newId ?? randomUUID)();
    if (!this.deps.repo.claimLaunch(goal.id, runId, now)) return;
    this.touch(goal.id, "専用セッションの起動を依頼しました");
    let result: Awaited<ReturnType<DailyGoalServiceDeps["delegation"]["launch"]>>;
    try {
      result = await this.deps.delegation.launch({
        runId, goalId: goal.id, args: runnerArgs(goal, this.deps.baseUrl), cwd: goal.repoPath, project: goal.project,
        requesterDiscordUserId: goal.confirmedBy.userId, sourceGuildId: goal.confirmedBy.guildId, sourceChannelId: goal.confirmedBy.channelId,
      });
    } catch (error) {
      this.deps.repo.markLaunchUnknown(goal.id, `起動結果不明: ${String(error)}`, now);
      this.touch(goal.id, "起動の結果を確認できません。run 台帳と照合するまで再起動しません");
      return;
    }
    if (result.ok) {
      this.deps.repo.markLaunched(goal.id, result.runId, now);
      this.touch(goal.id, `専用セッションを起動しました (run ${result.runId.slice(0, 8)})`);
      return;
    }
    // invoke が失敗を返しても run が作られていれば起動済みかもしれない。照合に回す。
    if (this.deps.delegation.findRun(runId)) {
      this.deps.repo.markLaunchUnknown(goal.id, result.error, now);
      this.touch(goal.id, `起動の結果を照合中です: ${result.error}`);
      return;
    }
    this.deps.repo.releaseLaunch(goal.id, result.error, now + LAUNCH_RETRY_MS, now);
    this.touch(goal.id, `起動できませんでした (${result.error})。10 分後に再試行します`);
  }

  /** 結果不明の起動を照合し、 起動済みのゴールに専用セッションを紐付ける。 */
  reconcile(now: number): void {
    for (const goal of this.deps.repo.listByStatus(["confirmed"])) {
      if (goal.launchState !== "unknown" || !goal.runId) continue;
      const run = this.deps.delegation.findRun(goal.runId);
      if (!run) continue; // 見つかるまで再 invoke しない (CC-INV-03)。
      if (this.deps.repo.markLaunched(goal.id, run.id, now)) this.touch(goal.id, `起動を run 台帳で確認しました (run ${run.id.slice(0, 8)})`);
    }
    for (const goal of this.deps.repo.listByStatus(["running"])) {
      if (goal.sessionId || !goal.runId) continue;
      const run = this.deps.delegation.findRun(goal.runId);
      if (!run?.childSessionId) continue;
      if (!this.deps.repo.bindSession(goal.id, run.childSessionId, now)) continue;
      let note: string | null = null;
      this.deps.sessions.updateMetadata(run.childSessionId, (metadata) => {
        const bound = bindGoalToMetadata(metadata, goal, now);
        if (!bound.ok) note = bound.reason;
        return bound.metadata;
      });
      this.touch(goal.id, note ?? `専用セッション ${run.childSessionId} を紐付けました`);
    }
  }
}
