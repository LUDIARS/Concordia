/**
 * GET /v1/control/sessions の読み口 (Cc v5 実装メモ 13)。ボードの行に、プランと進捗を付けて返す。
 * - ステップと metadata は全セッション分を 1 回の照会で引く (セッション数で照会回数が増えない)
 * - Actio の紐付けは読み置き (task-links-cache.ts) から返し、応答は Actio の読み出しを短い時間しか待たない
 * - 読めなかった欄だけ unavailable (「取得できません」)
 *
 * @implements spec/feature/control-session.md §13 プランと進捗
 */
import type Database from "better-sqlite3";
import { readFollowupProgress } from "../control/followup-progress.js";
import { readSessionPlan } from "../session-plan/plan-state.js";
import { readSessionWorkPhase } from "../work/session-work-phase.js";
import { buildSessionProgress, type LinkedTaskState, type PlanStep, type SessionWithProgress, type TaskLinksReading } from "./session-progress-view.js";
import type { ControlBoardRowWithLink } from "./session-link.js";
import { createTaskLinksCache, type TaskLinksCacheOptions } from "./task-links-cache.js";

export interface SessionProgressReaderDeps {
  db: Database.Database;
  boardRows: () => ControlBoardRowWithLink[];
  /** 紐付いた Actio タスクの状態 (GET /v1/sessions/:id/task-links と同じ読み口)。読めなければ throw / null。 */
  readTaskLinks: (sessionId: string) => Promise<LinkedTaskState[] | null>;
  /** 紐付けがあるか (無ければ Actio を引かない)。 */
  hasTaskLinks: (metadata: string | null) => boolean;
  /** 読み置きの時間設定 (テスト用。既定は task-links-cache.ts)。 */
  taskLinksCache?: Omit<TaskLinksCacheOptions, "read">;
}

interface SessionFacts {
  id: string;
  repo_path: string;
  branch: string | null;
  current_task: string | null;
  metadata: string | null;
}

export function createSessionProgressReader(deps: SessionProgressReaderDeps) {
  const cache = createTaskLinksCache({ ...deps.taskLinksCache, read: deps.readTaskLinks });

  function taskLinks(session: SessionFacts | undefined): Promise<TaskLinksReading> | TaskLinksReading {
    if (!session) return { state: "unavailable" };
    if (!deps.hasTaskLinks(session.metadata)) return { state: "ok", items: [] };
    return cache.get(session.id);
  }

  return {
    async read(): Promise<SessionWithProgress[]> {
      const rows = deps.boardRows();
      if (!rows.length) return [];
      const ids = rows.map((row) => row.session_id);
      const marks = ids.map(() => "?").join(",");
      const sessions = new Map((deps.db.prepare(
        `SELECT id, repo_path, branch, current_task, metadata FROM sessions WHERE id IN (${marks})`,
      ).all(...ids) as SessionFacts[]).map((row) => [row.id, row]));
      const steps = new Map<string, PlanStep[]>();
      for (const record of deps.db.prepare(
        `SELECT session_id, task_text, status FROM session_task_records WHERE session_id IN (${marks}) ORDER BY first_seen_at ASC, id ASC`,
      ).all(...ids) as Array<{ session_id: string; task_text: string; status: PlanStep["status"] }>) {
        const list = steps.get(record.session_id) ?? [];
        list.push({ text: record.task_text, status: record.status });
        steps.set(record.session_id, list);
      }
      cache.retainOnly(ids);
      const links = await Promise.all(rows.map((row) => taskLinks(sessions.get(row.session_id))));
      return rows.map((row, index) => {
        const session = sessions.get(row.session_id);
        const metadata = session?.metadata ?? null;
        return buildSessionProgress({
          row,
          steps: steps.get(row.session_id) ?? [],
          desktopPlan: readSessionPlan(metadata),
          workPhase: readSessionWorkPhase({
            repo_path: session?.repo_path ?? "", branch: session?.branch ?? null,
            current_task: session?.current_task ?? null, metadata,
          }),
          followupFingerprint: readFollowupProgress(metadata)?.fingerprint ?? null,
          tasks: links[index]!,
        });
      });
    },
  };
}

export type SessionProgressReader = ReturnType<typeof createSessionProgressReader>;
