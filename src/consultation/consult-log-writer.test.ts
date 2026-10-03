import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConsultLogWriter, resolveConsultLogTarget, type ConsultLogSession, type ConsultLogWriterPorts } from "./consult-log-writer.js";

const ROOT = resolve("/consult-root");
const ROLE = join(ROOT, "engineer");
// 2026-10-03 18:25:16 JST
const STARTED_SEC = Date.UTC(2026, 9, 3, 9, 25, 16) / 1000;

function session(overrides: Partial<ConsultLogSession> = {}): ConsultLogSession {
  return {
    id: "s1",
    repo_path: ROLE,
    started_at: STARTED_SEC,
    metadata: JSON.stringify({ discord_requester_user_id: "123456789012345678", model: "claude-opus-5-5" }),
    department_id: "dept-consult",
    ...overrides,
  };
}

describe("resolveConsultLogTarget", () => {
  it("resolves the requester's log file for a consult session inside the workspace root", () => {
    const target = resolveConsultLogTarget({ session: session(), isConsultDepartment: true, workspaceRoot: ROOT });
    expect(target).toEqual({
      filePath: join(ROLE, "123456789012345678", "logs", "2026-10-03_s1.md"),
      roleFolder: "engineer",
      model: "claude-opus-5-5",
      startedAtMs: STARTED_SEC * 1000,
    });
  });

  it("returns null outside consult departments or outside the workspace root", () => {
    expect(resolveConsultLogTarget({ session: session(), isConsultDepartment: false, workspaceRoot: ROOT })).toBeNull();
    expect(resolveConsultLogTarget({ session: session(), isConsultDepartment: true, workspaceRoot: undefined })).toBeNull();
    expect(resolveConsultLogTarget({
      session: session({ repo_path: resolve("/repos/Concordia") }), isConsultDepartment: true, workspaceRoot: ROOT,
    })).toBeNull();
  });
});

function makeWriter(overrides: Partial<ConsultLogWriterPorts> = {}) {
  const files = new Map<string, string>();
  const ports: ConsultLogWriterPorts = {
    findSession: (id) => (id === "s1" ? session() : null),
    isConsultDepartment: (id) => id === "dept-consult",
    departmentName: () => "技術相談課",
    intake: () => ({ topic: "所有権", skill_level: "初級", role_title: "エンジニア", purpose: "知りたい" }),
    workspaceRoot: ROOT,
    fileExists: async (path) => files.has(path),
    append: async (path, text) => { files.set(path, (files.get(path) ?? "") + text); },
    log: { warn: vi.fn() },
    ...overrides,
  };
  return { writer: new ConsultLogWriter(ports), files, ports };
}

const LOG = join(ROLE, "123456789012345678", "logs", "2026-10-03_s1.md");

describe("ConsultLogWriter", () => {
  it("writes the header once and appends requester utterances and final answers in order", async () => {
    const { writer, files } = makeWriter();
    await writer.recordMessage("s1", { id: 1, ts: STARTED_SEC + 60, author_type: "user", author_platform: "discord", content: "所有権とは?" });
    await writer.recordMessage("s1", { id: 2, ts: STARTED_SEC + 61, author_type: "task", author_platform: null, content: "Cc の指令" });
    await writer.recordMessage("s1", { id: 3, ts: STARTED_SEC + 90, author_type: "assistant", author_platform: null, metadata: { phase: "commentary" }, content: "途中" });
    await writer.recordMessage("s1", { id: 4, ts: STARTED_SEC + 120, author_type: "assistant", author_platform: null, metadata: { phase: "final_answer" }, content: "回答です" });
    await writer.recordMessage("s1", { id: 4, ts: STARTED_SEC + 121, author_type: "assistant", author_platform: null, metadata: { phase: "final_answer" }, content: "回答です (編集)" });
    await writer.recordEnd("s1", STARTED_SEC + 300, "終了の指示 (発言)");

    const text = files.get(LOG)!;
    expect(text.match(/# 相談ログ/g)).toHaveLength(1);
    expect(text).toContain("- 知りたいこと: 所有権");
    expect(text).toContain("### 2026-10-03 18:26:16 (JST) 相談者の発言\n\n所有権とは?");
    expect(text).toContain("### 2026-10-03 18:27:16 (JST) 最終回答 (FINAL ANSWER)\n\n回答です");
    expect(text).not.toContain("Cc の指令");
    expect(text).not.toContain("途中");
    expect(text).not.toContain("(編集)");
    expect(text.indexOf("所有権とは?")).toBeLessThan(text.indexOf("回答です"));
    expect(text).toContain("- 終了: 2026-10-03 18:30:16 (JST)\n- 理由: 終了の指示 (発言)");
  });

  it("does nothing for sessions that are not consultations", async () => {
    const { writer, files } = makeWriter({ findSession: () => session({ department_id: "dept-general" }) });
    await writer.recordMessage("s1", { id: 1, ts: STARTED_SEC, author_type: "user", author_platform: "discord", content: "hi" });
    await writer.recordEnd("s1", STARTED_SEC + 10, "セッションの終了");
    expect(files.size).toBe(0);
  });

  it("keeps the consultation going when writing fails (warn only)", async () => {
    const warn = vi.fn();
    const { writer } = makeWriter({ append: async () => { throw new Error("disk full"); }, log: { warn } });
    await expect(writer.recordMessage("s1", { id: 1, ts: STARTED_SEC, author_type: "user", author_platform: "discord", content: "hi" }))
      .resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("consult-log: write failed session=s1"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("hi"));
  });

  it("records the end reason from session events", async () => {
    const { writer, files } = makeWriter({
      findSession: () => session({
        metadata: JSON.stringify({ discord_requester_user_id: "123456789012345678", session_end_requested_at: STARTED_SEC + 5 }),
      }),
    });
    writer.handleEvent({ type: "session.ended", session_id: "s1", ts: STARTED_SEC + 100 });
    await vi.waitFor(() => expect(files.get(LOG)).toContain("- 理由: 終了の指示 (発言)"));
  });
});
