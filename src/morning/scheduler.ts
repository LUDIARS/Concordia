/**
 * Morning task scheduler.
 *
 * - 30 分ごとに 8 時台かどうか判定
 * - 8 時台に入ったら Memoria から今日期限タスクを取得し、
 *   delegation "morning-tasks" で Lictor セッションを起動する
 * - 1 日 1 回のみ (lastFiredDate でインメモリ重複防止)
 */

import type { DelegationService } from "../delegation/service.js";
import { memoriaBaseUrl } from "../config/service-urls.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("morning-scheduler");
const TICK_MS = 30 * 60 * 1000;
const TARGET_HOUR = 8;

export interface MorningSchedulerDeps {
  delegationService: DelegationService;
  /** Memoria の base URL (既定 http://127.0.0.1:5180、env CONCORDIA_MEMORIA_URL で上書き可) */
  memoriaBaseUrl?: string;
}

export interface MorningSchedulerHandle {
  stop: () => void;
  /** テスト・手動起動用。dateIso を渡すと「fired today」チェックを bypass */
  runOnce: (opts?: { dateIso?: string; force?: boolean }) => Promise<void>;
}

interface MemoriaTask {
  id: number;
  title: string;
  category?: string | null;
  details?: string | null;
  status?: string | null;
  due_at?: string | null;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchTodayTasks(
  base: string,
  today: string,
): Promise<MemoriaTask[]> {
  try {
    const res = await fetch(`${base}/api/tasks?limit=200`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn({ status: res.status, base }, "Memoria API non-OK");
      return [];
    }
    const { items = [] } = (await res.json()) as { items?: MemoriaTask[] };
    return (items as MemoriaTask[]).filter(
      (t) =>
        t.status !== "done" &&
        typeof t.due_at === "string" &&
        t.due_at.startsWith(today),
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Memoria fetch failed");
    return [];
  }
}

function formatTaskList(tasks: MemoriaTask[]): string {
  return tasks
    .slice(0, 50)
    .map((t) => {
      const cat = t.category ? ` [${t.category}]` : "";
      const detail = t.details
        ? `\n    ${t.details.replace(/\s+/g, " ").trim().slice(0, 160)}`
        : "";
      return `・ #${t.id}${cat} ${t.title}${detail}`;
    })
    .join("\n");
}

export function startMorningScheduler(
  deps: MorningSchedulerDeps,
): MorningSchedulerHandle {
  let stopped = false;
  let lastFiredDate: string | null = null;

  const memoriaBase = deps.memoriaBaseUrl ?? memoriaBaseUrl();

  async function runOnce(opts: { dateIso?: string; force?: boolean } = {}): Promise<void> {
    if (stopped) return;
    const today = opts.dateIso ?? todayIso();

    if (!opts.force && lastFiredDate === today) {
      log.debug({ date: today }, "morning tasks already fired today");
      return;
    }

    const tasks = await fetchTodayTasks(memoriaBase, today);
    if (tasks.length === 0) {
      log.info({ date: today }, "no pending tasks due today — skip spawn");
      return;
    }

    lastFiredDate = today;
    const taskList = formatTaskList(tasks);

    log.info({ date: today, count: tasks.length }, "spawning morning-tasks session");

    const result = await deps.delegationService.invoke({
      call_name: "morning-tasks",
      args: { task_list: taskList, date: today },
      cwd: "E:\\Document\\Ars",
      triggered_by: "morning-scheduler",
    });

    if (!result.ok) {
      log.warn({ error: result.error, date: today }, "morning-tasks spawn failed");
    } else {
      log.info(
        { date: today, runId: result.run.id, pid: result.spawn_pid },
        "morning-tasks session spawned",
      );
    }
  }

  async function tick(): Promise<void> {
    const hour = new Date().getHours();
    if (hour !== TARGET_HOUR) return;
    await runOnce();
  }

  const supervised = startSupervisedInterval("morning-scheduler", tick, {
    intervalMs: TICK_MS,
    initialDelayMs: 5_000,
    log: { warn: (message) => log.warn(message) },
  });

  log.info({ tickMs: TICK_MS, targetHour: TARGET_HOUR }, "morning task scheduler started");

  return {
    stop: () => {
      stopped = true;
      supervised.stop();
    },
    runOnce,
  };
}
