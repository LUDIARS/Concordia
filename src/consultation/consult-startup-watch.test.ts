import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { CONSULT_STARTUP_GRACE_SEC, consultStartupStalled, startConsultStartupWatch } from "./consult-startup-watch.js";

const root = "E:/Document/Consult";
const base = { provider: "claude-code", repoPath: "E:\\Document\\Consult\\engineer", startedAtSec: 1_000, transcriptPath: null };

describe("consultStartupStalled", () => {
  it("相談用ディレクトリの claude が猶予を過ぎても transcript を持たなければ止まっている", () => {
    expect(consultStartupStalled({ ...base, nowSec: 1_000 + CONSULT_STARTUP_GRACE_SEC }, root)).toBe(true);
  });

  it("猶予内・transcript あり・相談以外の場所・claude 以外は止まっていない", () => {
    expect(consultStartupStalled({ ...base, nowSec: 1_000 + CONSULT_STARTUP_GRACE_SEC - 1 }, root)).toBe(false);
    expect(consultStartupStalled({ ...base, transcriptPath: "x.jsonl", nowSec: 99_999 }, root)).toBe(false);
    expect(consultStartupStalled({ ...base, repoPath: "E:/Document/Ars/Concordia", nowSec: 99_999 }, root)).toBe(false);
    // codex は transcript を SessionStart フックで報告するので別の経路 (この見張りの対象外)。
    expect(consultStartupStalled({ ...base, provider: "codex-cli", nowSec: 99_999 }, root)).toBe(false);
  });
});

describe("startConsultStartupWatch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const row = (over: Partial<SessionRow>): SessionRow => ({
    id: "s1", provider: "claude-code", repo_path: "E:/Document/Consult/engineer", repo_origin: null, branch: "main", host: "h",
    started_at: 1_000, ended_at: null, status: "active", last_seen_at: 0, current_task: null, transcript_path: null,
    metadata: null, ws_clients: 1, ...over,
  } as SessionRow);

  it("止まった相談セッションを 1 度だけ知らせ、 再ログインのコマンドを添える", () => {
    const posts: string[] = [];
    let sessions = [row({ id: "stuck" }), row({ id: "ok", transcript_path: "t.jsonl" }), row({ id: "dev", repo_path: "E:/Document/Ars/Concordia" })];
    const watcher = startConsultStartupWatch({
      sessions: { listSessions: () => sessions } as never,
      consultRoot: root,
      reloginCommand: "RELOGIN",
      post: (text) => posts.push(text),
      intervalMs: 1_000,
      now: () => (1_000 + CONSULT_STARTUP_GRACE_SEC) * 1000,
    });
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("stuck");
    expect(posts[0]).toContain("RELOGIN");
    // セッションが消えたら追跡を外す (同じ id が再び現れたらまた知らせる)。
    sessions = [];
    vi.advanceTimersByTime(1_000);
    sessions = [row({ id: "stuck" })];
    vi.advanceTimersByTime(1_000);
    expect(posts).toHaveLength(2);
    watcher.stop();
  });
});
