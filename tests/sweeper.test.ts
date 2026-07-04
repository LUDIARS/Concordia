import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { PersonasRepo } from "../src/db/personas-repo.js";
import { startSweeper } from "../src/sweeper.js";
import { subscribeSessionLostDispatcher } from "../src/control/session-lost-dispatcher.js";
import type { SessionRow } from "../src/shared/types.js";

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});

function startSession(repo: SessionsRepo, id: string, lastSeenAt: number): void {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/workspace/project",
    repo_origin: "origin",
    branch: "main",
    host: "host",
    started_at: lastSeenAt,
    last_seen_at: lastSeenAt,
    transcript_path: null,
    metadata: null,
  });
}

describe("sweeper session.lost dispatch", () => {
  it("emits lost once and lets the event adapter notify dispatcher once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:30Z"));
    const now = Math.floor(Date.now() / 1000);
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const tasks = new TasksRepo(db);
    const personas = new PersonasRepo(db);
    startSession(sessions, "stale-one", now - 100);

    const lostRows: SessionRow[] = [];
    cleanup.push(subscribeSessionLostDispatcher({
      sessions,
      dispatcher: { onSessionLost: (lost) => { lostRows.push(lost); } },
    }));

    const sweeper = startSweeper({
      repo: sessions,
      tasks,
      personas,
      intervalMs: 60_000,
      lostAfterSec: 10,
      abandonedAfterSec: 3_600,
      lostPurgeAfterSec: 3_600,
      purgeAfterDays: 30,
    });
    cleanup.push(sweeper.stop);

    sweeper.runOnce();
    sweeper.runOnce();

    expect(lostRows.map((s) => s.id)).toEqual(["stale-one"]);
    expect(lostRows[0]?.status).toBe("lost");
  });
});
