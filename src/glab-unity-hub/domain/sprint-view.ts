/**
 * テルプシコラ (スプリント) の表示モデル (契約 v1 §4b `sprint.current`)。
 *
 * 正本は Actio。 Breviarium の cross-project-sprints と同じ数え方に揃える:
 *  - 経過率: 開始日〜終了日 (JST 暦日) のうち、 Actio が数えた日までに過ぎた割合。 終了日以降は 1。
 *  - 消化率: done / (total − cancelled)。 プロジェクトのタスクが 1 件も無ければスプリント全体で数える。
 *  - 現在のスプリント: Actio のチーム順で最初に active スプリントを持つチーム。
 *
 * @implements spec/feature/glab-unity-hub.md §4b (GUH-SPRINT)
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:98348db2 */
import augurContract_73215af9 from './sprint-assignee.contract.js'; /* augur-inject:contract-predicate:4ed0de31 */

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface ActioStatusCounts { readonly [status: string]: number }

export interface ActioActiveSprint {
  readonly id: string;
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly tasks: {
    readonly total: number;
    readonly byStatus: ActioStatusCounts;
    readonly project: { readonly total: number; readonly byStatus: ActioStatusCounts };
  };
}

export interface ActioSprintAggregate {
  readonly project: string;
  readonly generatedAt: string;
  readonly teams: ReadonlyArray<{ readonly teamId: string; readonly teamName: string; readonly activeSprint: ActioActiveSprint | null }>;
}

export interface SprintTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly due: string | null;
  readonly url: string | null;
}

export interface SprintCurrentView {
  readonly project: string;
  readonly sprint: {
    readonly name: string;
    readonly goal: string | null;
    readonly startAt: string;
    readonly endAt: string;
    readonly elapsedRatio: number;
    readonly completedRatio: number | null;
  } | null;
  readonly tasks: readonly SprintTaskRow[];
  readonly updatedAt: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** 時刻の JST 暦日。 */
export function jstDateOf(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 暦日 `YYYY-MM-DD` の 00:00 JST を UTC ISO で返す。 */
export function jstDayStart(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - JST_OFFSET_MS).toISOString();
}

/** Breviarium `elapsedRatio` と同じ式。 */
export function elapsedRatio(startsOn: string, endsOn: string, today: string): number {
  if (daysBetween(endsOn, today) >= 0) return 1;
  const span = daysBetween(startsOn, endsOn);
  const passed = daysBetween(startsOn, today);
  if (!(span > 0) || !Number.isFinite(passed)) return 0;
  return Math.min(1, Math.max(0, passed / span));
}

function doneOfTotal(total: number, byStatus: ActioStatusCounts): { done: number; total: number } {
  const cancelled = byStatus["cancelled"] ?? 0;
  return { done: byStatus["done"] ?? 0, total: Math.max(0, total - cancelled) };
}

/** Breviarium `consumptionOf` と同じ式。 タスクが無ければ null。 */
export function completedRatio(sprint: ActioActiveSprint): number | null {
  const project = doneOfTotal(sprint.tasks.project.total, sprint.tasks.project.byStatus);
  if (project.total > 0) return Math.min(1, project.done / project.total);
  const whole = doneOfTotal(sprint.tasks.total, sprint.tasks.byStatus);
  if (whole.total > 0) return Math.min(1, whole.done / whole.total);
  return null;
}

export function currentActiveSprint(aggregate: ActioSprintAggregate): ActioActiveSprint | null {
  return aggregate.teams.find((team) => team.activeSprint !== null)?.activeSprint ?? null;
}

const STATUS_ORDER = ["in_progress", "blocked", "open", "done", "cancelled"];

/** タスクは状態別 (進行中 → 停止 → 未着手 → 完了 → 中止) に並べる。 */
export function sortSprintTasks(tasks: readonly SprintTaskRow[]): SprintTaskRow[] {
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status);
    return index < 0 ? STATUS_ORDER.length : index;
  };
  return [...tasks].sort((a, b) => rank(a.status) - rank(b.status) || a.title.localeCompare(b.title));
}

export function buildSprintView(input: {
  readonly project: string;
  readonly aggregate: ActioSprintAggregate;
  readonly tasks: readonly SprintTaskRow[];
}): SprintCurrentView {
  const sprint = currentActiveSprint(input.aggregate);
  const today = jstDateOf(input.aggregate.generatedAt) ?? input.aggregate.generatedAt.slice(0, 10);
  return {
    project: input.project,
    sprint: sprint
      ? {
        name: sprint.name,
        goal: sprint.goal,
        startAt: jstDayStart(sprint.startsOn),
        endAt: new Date(Date.parse(jstDayStart(sprint.endsOn)) + DAY_MS).toISOString(),
        elapsedRatio: elapsedRatio(sprint.startsOn, sprint.endsOn, today),
        completedRatio: completedRatio(sprint),
      }
      : null,
    tasks: sprint ? sortSprintTasks(input.tasks) : [],
    updatedAt: input.aggregate.generatedAt,
  };
}

/**
 * スプリントのタスク状態を変えてよいか。 Actio はローカル持ち主として書くので、
 * 「誰の操作として通すか」は Hub が決める: 担当者が本人のタスクだけ。
 */
export function mayUpdateSprintTask(task: { readonly assigneeId: string | null }, actorActioUserId: string | null): boolean {
  return actorActioUserId !== null && task.assigneeId !== null && task.assigneeId === actorActioUserId;
}
// @ts-expect-error augur-inject
mayUpdateSprintTask = contract(mayUpdateSprintTask, { ...augurContract_73215af9, contractId: 'guh-C-6', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/sprint-view.ts:143', rule: 'contract-wrap', id: '73215af9' }); /* augur-inject:contract-wrap:73215af9 */
