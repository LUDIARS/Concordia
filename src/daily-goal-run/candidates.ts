/**
 * ゴール候補 (朝の候補カード) の組み立てと準備。
 *
 * @implements spec/feature/daily-goal-run.md — 1. ゴール候補を出す / 6. 終わり方 (やり切りの残りは翌朝の候補) / CC-DG-INV-01 / CC-DG-INV-08
 *
 * 候補は案であり、 起動もゴール化もしない。 材料は Actio の進行中・期限の近い task (読み取りのみ)、
 * 前日の「やり切り」の残り、 日をまたいで継続中のゴール (2 本目を起動しないための表示)。
 */

import { createHash } from "node:crypto";
import { candidateAt, localDate } from "./launch-policy.js";
import type { DailyGoal, GoalCandidate } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

type ActioTask = GoalCandidate["actioTasks"][number];

export function candidateId(date: string, project: string): string {
  return `cand-${createHash("sha256").update(`${date}\n${project}`).digest("hex").slice(0, 20)}`;
}

/** 期限の近い順 (期限なしは後ろ) に並べ、 上位だけを候補に載せる (純関数)。 */
export function buildCandidate(input: {
  date: string; project: string; repoPath: string; now: number;
  tasks: readonly ActioTask[]; previousExhausted: readonly DailyGoal[]; running: readonly DailyGoal[];
}): GoalCandidate {
  const tasks = [...input.tasks]
    .filter((task) => task.status === "pending" || task.status === "delegated")
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))
    .slice(0, 5);
  const carryover = input.previousExhausted.flatMap((goal) => (goal.remaining ?? []).map((item) => ({
    goalId: goal.id, item: item.item, class: item.class, ...(item.class === "unachievable" ? { reason: item.reason } : {}),
  }))).slice(0, 10);
  const continuing = input.running.map((goal) => ({ goalId: goal.id, goalText: goal.goalText }));
  const lead = tasks[0]?.title ?? carryover[0]?.item ?? "";
  return {
    id: candidateId(input.date, input.project), date: input.date, project: input.project, repoPath: input.repoPath,
    suggestedGoal: lead ? `${lead} を完了させる` : "",
    suggestedAcceptance: tasks.slice(0, 3).map((task) => `Actio task ${task.id} (${task.title}) が完了している`),
    actioTaskIds: tasks.slice(0, 3).map((task) => task.id),
    actioTasks: tasks, carryover, continuing, createdAt: input.now,
  };
}

export class DailyGoalCandidates {
  private preparedFor: string | null = null;

  constructor(private readonly deps: DailyGoalServiceDeps, private readonly touchCandidate: (candidateId: string) => void) {}

  /** 起動時刻の 30 分前に 1 回、 その日の候補を用意する。 */
  async prepareIfDue(now: number): Promise<void> {
    const config = this.deps.config();
    const date = localDate(now);
    if (this.preparedFor === date || now < candidateAt(date, config.launchTime)) return;
    this.preparedFor = date;
    await this.prepare(date, now);
  }

  /** 指定日の候補を設定のプロジェクトだけ用意する。 既定 (空) は候補カードを出さない。 */
  async prepare(date: string, now: number, onlyProject?: string): Promise<void> {
    const config = this.deps.config();
    const previousDate = localDate(new Date(`${date}T12:00:00`).getTime() - 24 * 3_600_000);
    for (const name of config.candidateProjects) {
      const project = this.deps.projects.resolve(name);
      if (!project || (onlyProject && project.project !== onlyProject)) continue;
      let tasks: ActioTask[] = [];
      try { tasks = (await this.deps.tasks?.activeTasks(project.project)) ?? []; }
      catch (error) { this.deps.log?.warn(`daily goal candidate tasks unavailable project=${project.project}: ${String(error)}`); }
      const running = this.deps.repo.listByStatus(["confirmed", "running"]).filter((goal) => goal.project === project.project);
      const candidate = buildCandidate({
        date, project: project.project, repoPath: project.repoPath, now, tasks,
        previousExhausted: [...this.deps.repo.finishedOn(previousDate, project.project), ...this.deps.repo.finishedOn(date, project.project)],
        running,
      });
      if (this.deps.repo.upsertCandidate(candidate)) this.touchCandidate(candidate.id);
    }
  }
}
