/**
 * runSessionEndFlow の動作確認.
 *
 * CONCORDIA_DISABLE_CLAUDE=1 を立てて claude CLI を呼ばず fallback template 経路
 * を通す. これで AI narrative が無い環境でも report 生成 + 独白投稿が
 * 一連で動くことを確認できる.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { TranscriptLogsRepo } from "../src/db/transcript-logs-repo.js";
import { runSessionEndFlow, withNeedsHumanNotice } from "../src/control/end-session-flow.js";
import { loadConfig } from "../src/shared/config.js";
import { makeTestDb } from "./helpers/db.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";
import type { ProviderName, SessionEventRow, SessionReportRow } from "../src/shared/types.js";

function fakeReport(metadata: string | null): SessionReportRow {
  return { session_id: "s", generated_at: 0, summary_md: "", bullets: "{}", duration_sec: 0, metadata };
}
function injectEvent(source: string): SessionEventRow {
  return { id: 1, session_id: "s", ts: 1, kind: "inject", payload: JSON.stringify({ source }) };
}

describe("withNeedsHumanNotice", () => {
  it("needsHuman があれば起因者メンション + 箇条書きを独白冒頭に被せる", () => {
    const report = fakeReport(JSON.stringify({ summary_flags: { blocked: [], needsHuman: ["方針確認", "本番影響不明"] } }));
    const out = withNeedsHumanNotice("詩。", report, [injectEvent("discord:123:c:m")]);
    expect(out).toContain("<@123>");
    expect(out).toContain("人間の確認が必要");
    expect(out).toContain("- 方針確認");
    expect(out).toContain("詩。");
  });
  it("needsHuman 無し / metadata 無しは独白そのまま", () => {
    expect(withNeedsHumanNotice("詩。", fakeReport(null), [])).toBe("詩。");
    expect(withNeedsHumanNotice("詩。", fakeReport(JSON.stringify({ summary_flags: { blocked: ["x"], needsHuman: [] } })), [])).toBe("詩。");
  });
  it("起因者が discord でない/不明ならメンション無しで通知のみ", () => {
    const report = fakeReport(JSON.stringify({ summary_flags: { blocked: [], needsHuman: ["確認"] } }));
    const out = withNeedsHumanNotice("詩。", report, []);
    expect(out).not.toContain("<@");
    expect(out).toContain("- 確認");
  });
});

function makeEnv() {
  const db = makeTestDb();
  const repo = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  // template renderer = LLM 非使用 (テストで実 API/CLI を叩かない).
  const config = { ...loadConfig({}) };
  return { db, repo, tasks, chat, config };
}

function endedSession(
  repo: SessionsRepo,
  id: string,
  now: number,
  provider: ProviderName = "claude-code",
) {
  repo.insertSession({
    id,
    provider,
    repo_path: "/repo",
    repo_origin: null,
    branch: "main",
    host: "h",
    started_at: now - 600,
    last_seen_at: now,
    transcript_path: null,
    metadata: JSON.stringify({ role_label: "雑用係" }),
  });
  repo.appendEvent({ session_id: id, ts: now - 500, kind: "prompt", payload: { summary: "tweak" } });
  repo.appendEvent({ session_id: id, ts: now - 400, kind: "edit", payload: { file: "/repo/x" } });
  repo.setStatus(id, "ended", now, now);
  repo.appendEvent({ session_id: id, ts: now, kind: "end", payload: { stopped_by: "admin" } });
  return repo.findSession(id)!;
}

describe("runSessionEndFlow", () => {
  let env: ReturnType<typeof makeEnv>;
  let prevDisable: string | undefined;

  beforeAll(() => {
    prevDisable = process.env.CONCORDIA_DISABLE_CLAUDE;
    process.env.CONCORDIA_DISABLE_CLAUDE = "1";
  });
  afterAll(() => {
    if (prevDisable === undefined) delete process.env.CONCORDIA_DISABLE_CLAUDE;
    else process.env.CONCORDIA_DISABLE_CLAUDE = prevDisable;
  });
  beforeEach(() => { env = makeEnv(); });

  it("ended session に対して report row を upsert し fallback template が入る", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ended = endedSession(env.repo, "s1", now);

    const result = await runSessionEndFlow(env, ended);
    expect(result.report).not.toBeNull();
    const stored = env.repo.findReport("s1");
    expect(stored).not.toBeNull();
    // fallback では先頭に role 込みの placeholder が入り、 `\n---` で 3 セクション化される
    expect(stored!.summary_md).toContain("---");
    expect(stored!.duration_sec).toBe(600);
  });

  it("monologue (poem) が抽出できれば #報告 channel に投稿される", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ended = endedSession(env.repo, "s2", now);
    const events: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((ev) => events.push(ev));

    const result = await runSessionEndFlow(env, ended);
    unsubscribe();
    expect(result.postedMessageId).not.toBeNull();
    const msgs = env.chat.list({ channel: "報告", limit: 10 });
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const m = msgs.find((x) => x.session_id === "s2");
    expect(m).toBeTruthy();
    const posted = events.find((ev) => ev.type === "chat.posted" && ev.message_id === m!.id);
    expect(posted).toMatchObject({ type: "chat.posted", session_id: "s2" });
    expect(m!.channel).toBe("報告");
  });

  it("codex-sdk は usageFrames 経由で transcript frame から usage をレポートに載せる", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ended = endedSession(env.repo, "s5", now, "codex-sdk");
    const transcripts = new TranscriptLogsRepo(env.db);
    // 同一 thread の 2 turn。 frame の値はスレッド累積なので合算せず最大値 (3000) を採る。
    transcripts.insert({
      session_id: "s5", seq: 0, ts: now - 300, kind: "raw",
      payload: { type: "codex_usage", thread_id: "t1", input_tokens: 900, cached_input_tokens: 100, output_tokens: 100, total_tokens: 1000 },
    });
    transcripts.insert({
      session_id: "s5", seq: 1, ts: now - 200, kind: "raw",
      payload: { type: "codex_usage", thread_id: "t1", input_tokens: 2500, cached_input_tokens: 400, output_tokens: 500, total_tokens: 3000 },
    });
    // 別 session の frame が混ざらないこと
    transcripts.insert({
      session_id: "other", seq: 0, ts: now - 100, kind: "raw",
      payload: { type: "codex_usage", thread_id: "t9", input_tokens: 90000, output_tokens: 9000, total_tokens: 99000 },
    });

    const result = await runSessionEndFlow({ ...env, usageFrames: transcripts }, ended);
    // codex-sdk は単価不明なので usd 化せず「未価格」トークンとして載る。
    expect(result.report!.summary_md).toContain("## コスト / コンテキスト");
    expect(result.report!.summary_md).toContain("未価格 3k tok");
  });

  it("codex-sdk でも usageFrames 未注入なら未計測 (コスト行を出さない)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ended = endedSession(env.repo, "s6", now, "codex-sdk");
    const transcripts = new TranscriptLogsRepo(env.db);
    transcripts.insert({
      session_id: "s6", seq: 0, ts: now - 200, kind: "raw",
      payload: { type: "codex_usage", thread_id: "t1", input_tokens: 2500, output_tokens: 500, total_tokens: 3000 },
    });

    const result = await runSessionEndFlow(env, ended);
    // 0 を実測値と偽らず、 セクションごと省く。
    expect(result.report!.summary_md).not.toContain("## コスト / コンテキスト");
  });

  it("session end flow does not enqueue peer chat tasks", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ended = endedSession(env.repo, "s4", now);

    await runSessionEndFlow(env, ended);

    const pulled = env.tasks.pull("s4");
    expect(pulled.length).toBe(0);
  });
});
