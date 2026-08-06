import { describe, expect, it } from "vitest";
import type { SessionEventRow, SessionRow } from "../shared/types.js";
import { buildSummaryFlagsPrompt } from "./summary-flags.js";

function sessionRow(): SessionRow {
  return {
    id: "session-1",
    provider: "claude-code",
    repo_path: "/repo",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1,
    ended_at: 300,
    status: "ended",
    last_seen_at: 300,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
  };
}

function eventRow(
  id: number,
  kind: string,
  payload: object,
  ts = id,
): SessionEventRow {
  return {
    id,
    session_id: "session-1",
    ts,
    kind,
    payload: JSON.stringify(payload),
  };
}

describe("detectSummaryFlags question completion input", () => {
  it("長い通常イベントを切り詰めても解決済み証跡を入力末尾に保持する", () => {
    const events = [
      eventRow(1, "prompt", { text: `質問 #1190 は未回答 ${"x".repeat(20_000)}` }, 100),
      eventRow(2, "pending_question", { question_id: 1190 }, 110),
      eventRow(3, "question_answered", {
        question_id: 1190,
        answer_text: "両方マージして",
      }, 120),
    ];

    const prompt = buildSummaryFlagsPrompt(sessionRow(), events);
    expect(prompt).toContain("質問 #1190 は未回答");
    expect(prompt).toContain("## 解決済み質問");
    expect(prompt).toContain('"question_id": "1190"');
    expect(prompt).not.toContain('"answer_text"');
    expect(prompt.indexOf("## 解決済み質問")).toBeGreaterThan(
      prompt.indexOf("質問 #1190 は未回答"),
    );
  });
});
