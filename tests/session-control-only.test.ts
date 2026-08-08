/**
 * セッションコントロールのみ構成の回帰テスト。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W1-3
 *
 * 全ワークフローを無効にした状態でも、 セッション登録 / inject / transcript 中継 /
 * 許可応答 / セッション停止 が動くことを固定する。 ワークフローを使わない拠点・個人利用
 * でも Concordia を「セッション制御基盤」として使えることが、 この機能の一番の成果物。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eventBus } from "../src/events.js";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";
import { WORKFLOW_KEYS } from "../src/workflow/keys.js";

const SESSION_ID = "session-control-only";

function jsonPost(path: string, body: unknown): [string, RequestInit] {
  return [path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }];
}

describe("セッションコントロールのみ構成 (全ワークフロー無効)", () => {
  let env: TestAppEnv;

  beforeEach(() => {
    env = makeTestApp();
    for (const key of WORKFLOW_KEYS) env.adminState.setWorkflowEnabled(key, false);
  });

  it("前提: 全ワークフローが無効になっている", () => {
    expect(env.adminState.workflows.isSessionControlOnly()).toBe(true);
    for (const key of WORKFLOW_KEYS) {
      expect(env.adminState.isWorkflowEnabled(key), `workflow.${key}`).toBe(false);
    }
  });

  it("セッション登録ができる", async () => {
    const r = await env.app.request(...jsonPost("/v1/sessions", {
      id: SESSION_ID,
      provider: "claude-code",
      repo_path: "/repo",
      host: "DESKTOP-A",
    }));
    expect(r.status).toBe(200);
    expect(env.repo.findSession(SESSION_ID)?.status).toBe("active");
  });

  it("inject が通り session.inject が emit される", async () => {
    await env.app.request(...jsonPost("/v1/sessions", {
      id: SESSION_ID, provider: "claude-code", repo_path: "/repo", host: "DESKTOP-A",
    }));

    const captured: Array<{ type: string }> = [];
    const unsubscribe = eventBus.subscribe((ev) => {
      if (ev.type === "session.inject") captured.push(ev);
    });
    try {
      const r = await env.app.request(...jsonPost(`/v1/sessions/${SESSION_ID}/inject`, {
        text: "続けてください",
        source: "test",
      }));
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("transcript frame の中継ができる", async () => {
    await env.app.request(...jsonPost("/v1/sessions", {
      id: SESSION_ID, provider: "claude-code", repo_path: "/repo", host: "DESKTOP-A",
    }));

    // 中継の emit は「active session + active チャンネル紐付け」が条件。
    env.discordChannels.upsert({ session_id: SESSION_ID, channel_id: "ch-1", status: "active" });

    const captured: Array<{ type: string }> = [];
    const unsubscribe = eventBus.subscribe((ev) => {
      if (ev.type === "transcript.frame") captured.push(ev);
    });
    try {
      const r = await env.app.request(...jsonPost(`/v1/sessions/${SESSION_ID}/transcript-frame`, {
        seq: 0,
        kind: "text",
        payload: { role: "assistant", text: "作業を続けます" },
      }));
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("許可要求の中継ができる (session.permission_request が emit される)", async () => {
    await env.app.request(...jsonPost("/v1/sessions", {
      id: SESSION_ID, provider: "claude-code", repo_path: "/repo", host: "DESKTOP-A",
    }));

    const captured: Array<{ type: string; request_id?: string }> = [];
    const unsubscribe = eventBus.subscribe((ev) => {
      if (ev.type === "session.permission_request") captured.push(ev);
    });
    try {
      const r = await env.app.request(...jsonPost(`/v1/sessions/${SESSION_ID}/permission-request`, {
        request_id: "req-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }));
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ request_id: "req-1" });
    } finally {
      unsubscribe();
    }
  });

  it("AskUserQuestion の出題と回答ができる", async () => {
    await env.app.request(...jsonPost("/v1/sessions", {
      id: SESSION_ID, provider: "claude-code", repo_path: "/repo", host: "DESKTOP-A",
    }));

    const posted = await env.app.request(...jsonPost(`/v1/sessions/${SESSION_ID}/pending-question`, {
      question: "どちらで進めますか",
      options: ["A 案", "B 案"],
    }));
    expect(posted.status).toBe(200);
    const { question_id: questionId } = await posted.json() as { question_id: number };

    const answered = await env.app.request(...jsonPost(`/v1/sessions/${SESSION_ID}/answer-question`, {
      question_id: questionId,
      answer_index: 1,
    }));
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ ok: true, answer_text: "B 案" });
  });

  it("セッション停止 (管理 API) が停止ジョブを積める", async () => {
    const previous = process.env.CONCORDIA_DISABLE_CLAUDE;
    process.env.CONCORDIA_DISABLE_CLAUDE = "1";
    try {
      await env.app.request(...jsonPost("/v1/sessions", {
        id: SESSION_ID, provider: "claude-code", repo_path: "/repo", host: "DESKTOP-A",
      }));
      env.repo.setMetadata(SESSION_ID, JSON.stringify({ lictor_pid: 4321 }));

      const r = await env.app.request(`/v1/admin/stop-session/${SESSION_ID}`, { method: "POST" });
      expect(r.status).toBe(202);
      const body = await r.json() as { status: string; job_id: string };
      expect(body.status).toBe("queued");
      expect(env.controlJobs.findById(body.job_id)?.status).toBe("queued");
      expect(env.repo.findSession(SESSION_ID)?.status).toBe("ended");
    } finally {
      if (previous === undefined) delete process.env.CONCORDIA_DISABLE_CLAUDE;
      else process.env.CONCORDIA_DISABLE_CLAUDE = previous;
    }
  });

  it("Discord slash command はセッションコントロール系だけ登録される", async () => {
    const { commandNamesForRegistration } = await import("../src/discord/commands.js");
    const names = commandNamesForRegistration({
      isWorkflowEnabled: (key) => env.adminState.isWorkflowEnabled(key),
    });
    expect(names).toContain("spawn");
    expect(names).toContain("end-session");
    expect(names).toContain("enter");
    expect(names).not.toContain("mmtask");
    expect(names).not.toContain("confirm");
    expect(names).not.toContain("prs");
  });
});
