import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventBus, type ConcordiaEvent } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { HUMAN_WAIT_KEY } from "./human-wait.js";
import { HUMAN_TODO_REPORT_KEY, readHumanTodoReport } from "./human-todo-digest.js";
import { releaseHumanTodoReport, reportHumanTodos } from "./human-todo-report.js";

function session(metadata: Record<string, unknown> = {}): SessionRow {
  return {
    id: "s", provider: "claude-code", repo_path: "/r", repo_origin: null, branch: null, host: "h",
    started_at: 0, ended_at: null, status: "active", last_seen_at: 0, current_task: null,
    transcript_path: null, metadata: JSON.stringify(metadata), ws_clients: 0,
  } as SessionRow;
}

function repoOf(row: SessionRow): Pick<SessionsRepo, "findSession" | "updateMetadata"> {
  return {
    findSession: (id: string) => (id === row.id ? row : null),
    updateMetadata: (id: string, fn: (current: Record<string, unknown>) => Record<string, unknown>) => {
      if (id === row.id) row.metadata = JSON.stringify(fn(JSON.parse(row.metadata ?? "{}")));
    },
  } as Pick<SessionsRepo, "findSession" | "updateMetadata">;
}

const changes: ConcordiaEvent[] = [];
let off: () => void = () => undefined;
beforeEach(() => {
  changes.length = 0;
  off = eventBus.subscribe((event) => {
    if (event.type === "session.human_todos_changed") changes.push(event);
  });
});
afterEach(() => off());

describe("自動確認ごとの人間のやること報告", () => {
  it("初回は報告し、同じ内容の次の巡回では通知しない", () => {
    const row = session({ [HUMAN_WAIT_KEY]: { active: true, summary: "担当を決める", task_references: [], since: 1 } });
    const deps = { repo: repoOf(row), listUnansweredQuestions: () => [{ id: 1, question: "進めますか?" }], now: () => 5_000 };

    expect(reportHumanTodos(deps, row).kind).toBe("report");
    expect(reportHumanTodos(deps, row).kind).toBe("unchanged");
    expect(changes).toHaveLength(1);
    const ev = changes[0] as Extract<ConcordiaEvent, { type: "session.human_todos_changed" }>;
    expect(ev.change).toBe("report");
    expect(ev.item_count).toBe(2);
    expect(ev.text).toContain("担当を決める");
    expect(ev.text).toContain("進めますか?");
    expect(readHumanTodoReport(row.metadata)).toMatchObject({ digest: ev.digest, count: 2, reported_at: 5_000 });
  });

  it("内容が変わったら再報告し、無くなったら解消を 1 回だけ知らせる", () => {
    const row = session();
    let questions = [{ id: 1, question: "A?" }];
    const deps = { repo: repoOf(row), listUnansweredQuestions: () => questions };
    reportHumanTodos(deps, row);
    questions = [{ id: 1, question: "A?" }, { id: 2, question: "B?" }];
    expect(reportHumanTodos(deps, row).kind).toBe("report");
    questions = [];
    expect(reportHumanTodos(deps, row).kind).toBe("resolved");
    expect(reportHumanTodos(deps, row).kind).toBe("none");
    expect(changes.map((ev) => (ev as { change: string }).change)).toEqual(["report", "report", "resolved"]);
    expect(readHumanTodoReport(row.metadata)).toBeNull();
  });

  it("終了したセッションには何もしない", () => {
    const row = { ...session(), status: "ended" } as SessionRow;
    expect(reportHumanTodos({ repo: repoOf(row), listUnansweredQuestions: () => [{ id: 1, question: "A?" }] }, row).kind).toBe("none");
    expect(changes).toHaveLength(0);
  });

  it("配信失敗の記録戻しは、同じ要約値のときだけ消す", () => {
    const row = session({ [HUMAN_TODO_REPORT_KEY]: { digest: "new", count: 1, reported_at: 1 } });
    releaseHumanTodoReport(repoOf(row), "s", "old");
    expect(readHumanTodoReport(row.metadata)?.digest).toBe("new");
    releaseHumanTodoReport(repoOf(row), "s", "new");
    expect(readHumanTodoReport(row.metadata)).toBeNull();
  });
});
