/**
 * runSessionEndFlow の動作確認.
 *
 * CONCORDIA_DISABLE_CLAUDE=1 を立てて claude CLI を呼ばず fallback template 経路
 * を通す. これで AI narrative が無い環境でも report 生成 + 独白投稿 + persona
 * release が一連で動くことを確認できる.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { PersonasRepo } from "../src/db/personas-repo.js";
import { seedPersonas } from "../src/personas/seeds.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ChatResponder } from "../src/chat/responder.js";
import { runSessionEndFlow } from "../src/control/end-session-flow.js";
import { loadConfig } from "../src/shared/config.js";
import { makeTestDb } from "./helpers/db.js";

function makeEnv() {
  const db = makeTestDb();
  const repo = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const personas = new PersonasRepo(db);
  seedPersonas(personas);
  // template renderer = LLM 非使用 (テストで実 API/CLI を叩かない).
  const responder = new ChatResponder({
    chat, personas, sessions: repo,
    renderConfig: () => ({ renderer: "template", model: "" }),
  });
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, responder, rng: () => 1 });
  responder.attachFanout(dispatcher);
  const config = { ...loadConfig({}), anthropicApiKey: "" };
  return { db, repo, tasks, chat, personas, dispatcher, config };
}

function endedSession(repo: SessionsRepo, id: string, now: number) {
  repo.insertSession({
    id,
    provider: "claude-code",
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

    const result = await runSessionEndFlow(env, ended);
    expect(result.postedMessageId).not.toBeNull();
    const msgs = env.chat.list({ channel: "報告", limit: 10 });
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const m = msgs.find((x) => x.session_id === "s2");
    expect(m).toBeTruthy();
    expect(m!.channel).toBe("報告");
  });

  it("persona が assign されていれば release される", async () => {
    const now = Math.floor(Date.now() / 1000);
    // assignment を作る
    const ended = endedSession(env.repo, "s3", now);
    const assignment = env.personas.assign("s3");
    expect(assignment).not.toBeNull();

    await runSessionEndFlow(env, ended);

    const stillActive = env.personas.findActiveBySession("s3");
    expect(stillActive).toBeNull();
  });

  it("dispatcher.onSessionEnd は終了セッションへ task を積まない (report 経路が独白を担う)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ended = endedSession(env.repo, "s4", now);

    await runSessionEndFlow(env, ended);

    const pulled = env.tasks.pull("s4");
    expect(pulled.length).toBe(0);
  });
});
