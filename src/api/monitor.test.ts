import { describe, expect, it, vi } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { monitorRouter } from "./monitor.js";

function session(id: string): SessionRow {
  return {
    id,
    provider: "codex-cli",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/repo",
    branch: "main",
    host: "test-host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 1,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
  };
}

describe("GET /conflicts", () => {
  it("shares the active-session population but honors an explicit cache bypass", async () => {
    let active = [session("one")];
    const listSessions = vi.fn(
      ({ status }: { status: string }) => status === "active" ? active : [],
    );
    const app = monitorRouter({
      repo: { listSessions } as unknown as SessionsRepo,
      now: () => 1_000,
    });
    const url = "/conflicts?repo=E%3A%2Frepo&branch=main";

    const first = await app.request(url);
    expect((await first.json() as { conflicts: unknown[] }).conflicts).toHaveLength(1);

    active = [session("one"), session("two")];
    const cached = await app.request(url);
    expect((await cached.json() as { conflicts: unknown[] }).conflicts).toHaveLength(1);

    const refreshed = await app.request(url, { headers: { "cache-control": "no-cache" } });
    expect((await refreshed.json() as { conflicts: unknown[] }).conflicts).toHaveLength(2);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });
});
