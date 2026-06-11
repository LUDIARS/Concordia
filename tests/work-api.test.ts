import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TranscriptLogsRepo } from "../src/db/transcript-logs-repo.js";
import { workRouter } from "../src/api/work.js";

function makeEnv() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const transcriptLogs = new TranscriptLogsRepo(db);
  const app = workRouter({ sessions, transcriptLogs, resolveWorkspaceRoots: () => [] });
  return { db, sessions, transcriptLogs, app };
}

function seedSession(
  repo: SessionsRepo,
  id: string,
  opts: { repo_path?: string; repo_origin?: string | null; branch?: string | null; status?: "active" | "ended" } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: opts.repo_path ?? "/repo/A",
    repo_origin: opts.repo_origin ?? null,
    branch: opts.branch ?? "main",
    host: "h",
    started_at: now - 100,
    last_seen_at: now,
    transcript_path: null,
    metadata: null,
  });
  if (opts.status === "ended") repo.setStatus(id, "ended", now, now);
}

function seedConversation(
  logs: TranscriptLogsRepo,
  sessionId: string,
  baseTs: number,
  frames: Array<{ kind: string; role?: string; text?: string }>,
) {
  frames.forEach((f, i) => {
    const payload: Record<string, unknown> = {};
    if (f.role !== undefined) payload.role = f.role;
    if (f.text !== undefined) payload.text = f.text;
    logs.insert({ session_id: sessionId, seq: i, ts: baseTs + i, kind: f.kind, payload });
  });
}

describe("/v1/work/conversations", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it("全 session の text+user/assistant frame を返す (filter なし)", async () => {
    seedSession(env.sessions, "s1", { repo_path: "/repo/A" });
    seedSession(env.sessions, "s2", { repo_path: "/repo/B" });
    seedConversation(env.transcriptLogs, "s1", 1000, [
      { kind: "text", role: "user", text: "hi A" },
      { kind: "tool-use" }, // non-conversation
      { kind: "text", role: "assistant", text: "ok A" },
    ]);
    seedConversation(env.transcriptLogs, "s2", 2000, [
      { kind: "text", role: "user", text: "hi B" },
    ]);

    const r = await env.app.request("/conversations");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.sessions).toHaveLength(2);
    const s1 = body.sessions.find((x: any) => x.session.id === "s1");
    expect(s1.conversation).toHaveLength(2);
    expect(s1.conversation.every((e: any) => e.kind === "text")).toBe(true);
  });

  it("repo_path filter で当該 repo の session だけ返す", async () => {
    seedSession(env.sessions, "s1", { repo_path: "/repo/A" });
    seedSession(env.sessions, "s2", { repo_path: "/repo/B" });
    seedConversation(env.transcriptLogs, "s1", 1000, [{ kind: "text", role: "user", text: "x" }]);
    seedConversation(env.transcriptLogs, "s2", 2000, [{ kind: "text", role: "user", text: "y" }]);

    const r = await env.app.request("/conversations?repo_path=" + encodeURIComponent("/repo/A"));
    const body = await r.json() as any;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].session.id).toBe("s1");
    expect(body.filter.repo_path).toBe("/repo/A");
  });

  it("status filter で active のみ返す", async () => {
    seedSession(env.sessions, "act", { repo_path: "/repo/A" });
    seedSession(env.sessions, "ended", { repo_path: "/repo/A", status: "ended" });

    const r = await env.app.request("/conversations?status=active");
    const body = await r.json() as any;
    const ids = body.sessions.map((s: any) => s.session.id);
    expect(ids).toContain("act");
    expect(ids).not.toContain("ended");
  });

  it("available_repos は status 不問で全 repo を集計", async () => {
    seedSession(env.sessions, "s1", { repo_path: "/repo/A" });
    seedSession(env.sessions, "s2", { repo_path: "/repo/A" });
    seedSession(env.sessions, "s3", { repo_path: "/repo/B", status: "ended" });

    const r = await env.app.request("/conversations?status=active");
    const body = await r.json() as any;
    // sessions[] は active のみ → /repo/B は含まれない
    expect(body.sessions.every((s: any) => s.session.repo_path === "/repo/A")).toBe(true);
    // available_repos[] は status 不問なので /repo/B も chip として出る
    const repoKeys = body.available_repos.map((r: any) => r.repo_path).sort();
    expect(repoKeys).toEqual(["/repo/A", "/repo/B"]);
    const a = body.available_repos.find((r: any) => r.repo_path === "/repo/A");
    expect(a.session_count).toBe(2);
  });

  it("limit_per_session で 1 session あたりの frame 数が抑えられる", async () => {
    seedSession(env.sessions, "s", { repo_path: "/repo/A" });
    const many = Array.from({ length: 100 }, (_, i) => ({
      kind: "text",
      role: i % 2 === 0 ? "user" : "assistant",
      text: `msg ${i}`,
    }));
    seedConversation(env.transcriptLogs, "s", 1000, many);

    const r = await env.app.request("/conversations?limit_per_session=10");
    const body = await r.json() as any;
    expect(body.sessions[0].conversation.length).toBeLessThanOrEqual(10);
  });

  it("text 以外 / role が user/assistant 以外は conversation から外れる", async () => {
    seedSession(env.sessions, "s", { repo_path: "/repo/A" });
    seedConversation(env.transcriptLogs, "s", 1000, [
      { kind: "text", role: "user", text: "ok" },
      { kind: "text", role: "system", text: "noise" },
      { kind: "tool-use" },
      { kind: "thinking" },
      { kind: "text", role: "assistant", text: "reply" },
    ]);
    const r = await env.app.request("/conversations");
    const body = await r.json() as any;
    const conv = body.sessions[0].conversation;
    expect(conv).toHaveLength(2);
    expect(conv.map((e: any) => (e.payload as any).role)).toEqual(["user", "assistant"]);
  });
});
