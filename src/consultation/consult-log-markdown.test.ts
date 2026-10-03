import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyConsultLogMessage,
  consultLogFilePath,
  formatJstTimestamp,
  renderConsultLogEntry,
  renderConsultLogFooter,
  renderConsultLogHeader,
} from "./consult-log-markdown.js";

// 2026-10-03 UTC 09:25:16 = JST 18:25:16
const STARTED = Date.UTC(2026, 9, 3, 9, 25, 16);

describe("formatJstTimestamp", () => {
  it("writes the time in JST", () => {
    expect(formatJstTimestamp(STARTED)).toBe("2026-10-03 18:25:16");
    // UTC 16:00 is already the next day in JST
    expect(formatJstTimestamp(Date.UTC(2026, 9, 3, 16, 0, 0))).toBe("2026-10-04 01:00:00");
  });
});

describe("consultLogFilePath", () => {
  it("places the log under the requester's data folder with the JST date and session id", () => {
    expect(consultLogFilePath({
      roleWorkspace: join("C:", "Consult", "engineer"), requesterDiscordUserId: "123456789012345678",
      sessionId: "lictor-abc", startedAtMs: STARTED,
    })).toBe(join("C:", "Consult", "engineer", "123456789012345678", "logs", "2026-10-03_lictor-abc.md"));
  });

  it("uses _unknown when there is no Discord id and strips path characters from the session id", () => {
    expect(consultLogFilePath({
      roleWorkspace: join("C:", "Consult", "general"), requesterDiscordUserId: null,
      sessionId: "../evil/id", startedAtMs: STARTED,
    })).toBe(join("C:", "Consult", "general", "_unknown", "logs", "2026-10-03_.._evil_id.md"));
  });
});

describe("classifyConsultLogMessage", () => {
  it("keeps human utterances and final answers only", () => {
    expect(classifyConsultLogMessage({ author_type: "user", author_platform: "discord" })).toBe("requester");
    expect(classifyConsultLogMessage({ author_type: "user", author_platform: "web" })).toBe("requester");
    expect(classifyConsultLogMessage({ author_type: "assistant", author_platform: null, metadata: { phase: "final_answer" } }))
      .toBe("answer");
    expect(classifyConsultLogMessage({ author_type: "summary", author_platform: null })).toBe("answer");
  });

  it("drops Cc directives, intermediate messages and tool output", () => {
    expect(classifyConsultLogMessage({ author_type: "user", author_platform: null })).toBeNull();
    expect(classifyConsultLogMessage({ author_type: "task", author_platform: null })).toBeNull();
    expect(classifyConsultLogMessage({ author_type: "system", author_platform: null })).toBeNull();
    expect(classifyConsultLogMessage({ author_type: "assistant", author_platform: null, metadata: { phase: "commentary" } }))
      .toBeNull();
    expect(classifyConsultLogMessage({ author_type: "tool", author_platform: null })).toBeNull();
    expect(classifyConsultLogMessage({ author_type: "thinking", author_platform: null })).toBeNull();
  });
});

describe("render", () => {
  it("writes the header with the intake", () => {
    const header = renderConsultLogHeader({
      sessionId: "s1", startedAtMs: STARTED, departmentName: "技術相談課", roleFolder: "engineer",
      model: "claude-opus-5-5",
      intake: { topic: "Rust の所有権", skill_level: "初級", role_title: "エンジニア", purpose: "" },
    });
    expect(header).toContain("- 開始: 2026-10-03 18:25:16 (JST)");
    expect(header).toContain("- 部署: 技術相談課");
    expect(header).toContain("- 役職: engineer");
    expect(header).toContain("- モデル: claude-opus-5-5");
    expect(header).toContain("- 知りたいこと: Rust の所有権");
    expect(header).toContain("- 目的: (未記入)");
  });

  it("marks a missing intake", () => {
    expect(renderConsultLogHeader({
      sessionId: "s1", startedAtMs: STARTED, departmentName: null, roleFolder: "general", model: null, intake: null,
    })).toContain("(記録なし)");
  });

  it("writes entries and the footer with JST times", () => {
    expect(renderConsultLogEntry("requester", STARTED, "質問です\n")).toContain("### 2026-10-03 18:25:16 (JST) 相談者の発言\n\n質問です");
    expect(renderConsultLogEntry("answer", STARTED, "回答")).toContain("最終回答 (FINAL ANSWER)");
    expect(renderConsultLogFooter(STARTED, "終了の指示 (発言)")).toContain("- 理由: 終了の指示 (発言)");
  });
});
