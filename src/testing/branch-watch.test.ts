import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startBranchWatch } from "./branch-watch.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import type { SessionRow } from "../shared/types.js";

function fakeSession(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    provider: "claude-code",
    repo_path: "/r",
    repo_origin: null,
    branch: "main",
    host: "h",
    started_at: 0,
    ended_at: null,
    status: "active",
    last_seen_at: 0,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    ...over,
  } as SessionRow;
}

function fakeSessionsRepo(sessions: () => SessionRow[]): SessionsRepo {
  return {
    listSessions: (_filter: unknown) => sessions(),
  } as unknown as SessionsRepo;
}

function fakeClaimsRepo(opts: {
  hasActiveClaim?: boolean;
  activeClaims?: ReturnType<TestingClaimsRepo["listActive"]>;
}): TestingClaimsRepo {
  return {
    hasActiveClaim: (_sessionId: string, _now: number) => opts.hasActiveClaim ?? false,
    listActive: (_now: number) => opts.activeClaims ?? [],
  } as unknown as TestingClaimsRepo;
}

describe("startBranchWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("branch 変化 → 通知が emit される", () => {
    const notifyCalls: Array<{ sessionId: string; text: string }> = [];
    let branch = "main";

    const sessions = fakeSessionsRepo(() => [fakeSession({ id: "s1", branch })]);
    const claims = fakeClaimsRepo({ hasActiveClaim: false });

    const watcher = startBranchWatch({
      sessions,
      claims,
      notify: (_repo, sessionId, text) => notifyCalls.push({ sessionId, text }),
      intervalMs: 1_000,
    });

    // 初観測 (first tick — prev が undefined なのでスキップ)
    vi.advanceTimersByTime(1_000);
    expect(notifyCalls).toHaveLength(0);

    // branch 変化 → 通知すべき
    branch = "feat/new";
    vi.advanceTimersByTime(1_000);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]!.sessionId).toBe("s1");
    expect(notifyCalls[0]!.text).toContain("main");
    expect(notifyCalls[0]!.text).toContain("feat/new");

    watcher.stop();
  });

  it("claim 保持中の session → 通知されない", () => {
    const notifyCalls: Array<unknown> = [];
    let branch = "main";

    const sessions = fakeSessionsRepo(() => [fakeSession({ id: "s1", branch })]);
    // active claim があるので通知は抑制
    const claims = fakeClaimsRepo({ hasActiveClaim: true });

    const watcher = startBranchWatch({
      sessions,
      claims,
      notify: (_repo, sessionId, text) => notifyCalls.push({ sessionId, text }),
      intervalMs: 1_000,
    });

    // 初観測
    vi.advanceTimersByTime(1_000);
    // branch 変化 + claim あり → 通知なし
    branch = "feat/new";
    vi.advanceTimersByTime(1_000);

    expect(notifyCalls).toHaveLength(0);

    watcher.stop();
  });

  it("クールダウン内の再変化 → 通知されない", () => {
    const notifyCalls: Array<unknown> = [];
    let branch = "main";

    const sessions = fakeSessionsRepo(() => [fakeSession({ id: "s1", branch })]);
    const claims = fakeClaimsRepo({ hasActiveClaim: false });

    const watcher = startBranchWatch({
      sessions,
      claims,
      notify: (_repo, sessionId, text) => notifyCalls.push({ sessionId, text }),
      intervalMs: 1_000,
    });

    // 初観測
    vi.advanceTimersByTime(1_000);

    // 1 回目の branch 変化 → 通知される
    branch = "feat/a";
    vi.advanceTimersByTime(1_000);
    expect(notifyCalls).toHaveLength(1);

    // クールダウン内 (1 秒後) に再変化 → 通知されない
    branch = "main";
    vi.advanceTimersByTime(1_000);
    expect(notifyCalls).toHaveLength(1); // 通知追加なし

    watcher.stop();
  });

  it("branch 不変 → 何も起きない", () => {
    const notifyCalls: Array<unknown> = [];

    // branch は常に "main" のまま変化しない
    const sessions = fakeSessionsRepo(() => [fakeSession({ id: "s1", branch: "main" })]);
    const claims = fakeClaimsRepo({ hasActiveClaim: false });

    const watcher = startBranchWatch({
      sessions,
      claims,
      notify: (_repo, sessionId, text) => notifyCalls.push({ sessionId, text }),
      intervalMs: 1_000,
    });

    // 複数回ティックしても branch が変わらないので通知なし
    vi.advanceTimersByTime(5_000);
    expect(notifyCalls).toHaveLength(0);

    watcher.stop();
  });
});
