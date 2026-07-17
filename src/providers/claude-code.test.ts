/**
 * claudeCodeProvider のユニットテスト (T0-2).
 * - transcriptPath のパスエンコーディング規則
 * - parseTranscript の JSONL 解析挙動
 * ファイルシステムには依存しない (fixture 文字列のみ使用).
 */

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCodeProvider, encodeCwdForClaude } from "./claude-code.js";

// ---------------------------------------------------------------------------
// encodeCwdForClaude
// ---------------------------------------------------------------------------

describe("encodeCwdForClaude", async () => {
  it("Unix パスのスラッシュを '-' に変換し先頭末尾の '-' を除去する", async () => {
    expect(encodeCwdForClaude("/home/user/project")).toBe("home-user-project");
  });

  it("Windows パスのバックスラッシュ・コロンを '-' に変換する", async () => {
    expect(encodeCwdForClaude("C:\\Users\\foo\\bar")).toBe("C-Users-foo-bar");
  });

  it("連続する区切り文字 (例: C:\\\\) は単一の '-' にまとめる", async () => {
    expect(encodeCwdForClaude("E:\\\\Document\\\\Ars")).toBe("E-Document-Ars");
  });

  it("ドットを '-' に変換する", async () => {
    expect(encodeCwdForClaude("/some/path.with.dots")).toBe("some-path-with-dots");
  });

  it("混在セパレータも正規化する", async () => {
    expect(encodeCwdForClaude("E:/Document/Ars/Concordia")).toBe("E-Document-Ars-Concordia");
  });
});

// ---------------------------------------------------------------------------
// transcriptPath
// ---------------------------------------------------------------------------

describe("claudeCodeProvider.transcriptPath", async () => {
  it("sessionId と cwd が揃っていれば正しいパスを返す", async () => {
    const sessionId = "abc-123";
    const cwd = "/home/user/myrepo";
    const result = await claudeCodeProvider.transcriptPath(sessionId, cwd);
    const expected = join(homedir(), ".claude", "projects", "home-user-myrepo", "abc-123.jsonl");
    expect(result).toBe(expected);
  });

  it("sessionId が空文字の場合は null を返す", async () => {
    expect(await claudeCodeProvider.transcriptPath("", "/some/path")).toBeNull();
  });

  it("cwd が空文字の場合は null を返す", async () => {
    expect(await claudeCodeProvider.transcriptPath("sid-001", "")).toBeNull();
  });

  it("Windows 形式の cwd を正しくエンコードする", async () => {
    const result = await claudeCodeProvider.transcriptPath("sid-win", "C:\\Users\\dev\\proj");
    const expected = join(homedir(), ".claude", "projects", "C-Users-dev-proj", "sid-win.jsonl");
    expect(result).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript
// ---------------------------------------------------------------------------

describe("claudeCodeProvider.parseTranscript — 基本動作", async () => {
  it("空文字列は jsonl_lines=0, last_message_role=system を返す", async () => {
    const result = await claudeCodeProvider.parseTranscript("");
    expect(result.jsonl_lines).toBe(0);
    expect(result.last_message_role).toBe("system");
    expect(result.last_text_summary).toBeUndefined();
    expect(result.last_tool_use).toBeUndefined();
    expect(result.todos).toBeUndefined();
  });

  it("空行・空白のみの行は jsonl_lines に数えない", async () => {
    const content = "\n   \n\n";
    const result = await claudeCodeProvider.parseTranscript(content);
    expect(result.jsonl_lines).toBe(0);
  });

  it("不正な JSON 行はスキップし例外を投げない", async () => {
    const content = [
      "not json at all",
      "{broken:",
      JSON.stringify({ role: "assistant", content: "valid" }),
    ].join("\n");
    await expect(claudeCodeProvider.parseTranscript(content)).resolves.toBeDefined();
    const result = await claudeCodeProvider.parseTranscript(content);
    expect(result.jsonl_lines).toBe(3);
    expect(result.last_text_summary).toBe("valid");
  });

  it("全行が不正 JSON でも last_message_role=system のまま返す", async () => {
    const result = await claudeCodeProvider.parseTranscript("not-json\nalso-invalid");
    expect(result.last_message_role).toBe("system");
    expect(result.last_text_summary).toBeUndefined();
  });
});

describe("claudeCodeProvider.parseTranscript — アシスタントメッセージ", async () => {
  it("role=assistant, content が文字列のメッセージを解析する", async () => {
    const line = JSON.stringify({ role: "assistant", content: "Hello from assistant" });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_text_summary).toBe("Hello from assistant");
    expect(result.last_message_role).toBe("assistant");
  });

  it("type=assistant でも解析できる (role フォールバック)", async () => {
    const line = JSON.stringify({ type: "assistant", content: "Fallback via type" });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_text_summary).toBe("Fallback via type");
  });

  it("content が配列で text フィールドを持つオブジェクトの場合も抽出する", async () => {
    const line = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Array content" }],
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_text_summary).toBe("Array content");
  });

  it("message.content からも文字列を抽出できる", async () => {
    const line = JSON.stringify({
      role: "assistant",
      message: { content: "Nested message content" },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_text_summary).toBe("Nested message content");
  });

  it("200 文字を超えるコンテンツは先頭 200 文字に切り詰める", async () => {
    const long = "A".repeat(300);
    const line = JSON.stringify({ role: "assistant", content: long });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_text_summary).toBe("A".repeat(200));
  });

  it("複数行のうち最後のアシスタントメッセージを返す", async () => {
    const lines = [
      JSON.stringify({ role: "assistant", content: "First" }),
      JSON.stringify({ role: "user", content: "User message" }),
      JSON.stringify({ role: "assistant", content: "Last" }),
    ].join("\n");
    const result = await claudeCodeProvider.parseTranscript(lines);
    expect(result.last_text_summary).toBe("Last");
  });

  it("role が user のメッセージは last_text_summary に採用されない", async () => {
    const line = JSON.stringify({ role: "user", content: "User says hi" });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_text_summary).toBeUndefined();
    expect(result.last_message_role).toBe("system");
  });
});

describe("claudeCodeProvider.parseTranscript — tool_use", async () => {
  it("type=tool_use のメッセージから last_tool_use を抽出する", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "Bash",
      input: { command: "ls -la" },
      ts: 1700000000,
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_tool_use).toEqual({
      tool: "Bash",
      input: { command: "ls -la" },
      ts: 1700000000,
    });
  });

  it("ts が数値でない場合は行インデックスを ts として使用する", async () => {
    const lines = [
      JSON.stringify({ type: "tool_use", name: "Read", input: {} }),
    ].join("\n");
    const result = await claudeCodeProvider.parseTranscript(lines);
    // 1行だけなので index=0
    expect(result.last_tool_use?.ts).toBe(0);
  });

  it("name が無い tool_use は tool='unknown' になる", async () => {
    const line = JSON.stringify({ type: "tool_use", input: { x: 1 } });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_tool_use?.tool).toBe("unknown");
  });

  it("input が無い tool_use は input={} になる", async () => {
    const line = JSON.stringify({ type: "tool_use", name: "Edit" });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.last_tool_use?.input).toEqual({});
  });

  it("複数 tool_use のうち最後のものを返す", async () => {
    const lines = [
      JSON.stringify({ type: "tool_use", name: "FirstTool", input: {} }),
      JSON.stringify({ type: "tool_use", name: "LastTool", input: {} }),
    ].join("\n");
    const result = await claudeCodeProvider.parseTranscript(lines);
    expect(result.last_tool_use?.tool).toBe("LastTool");
  });
});

describe("claudeCodeProvider.parseTranscript — todos (TodoWrite)", async () => {
  it("TodoWrite の todos フィールドを抽出する", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "First task", status: "in_progress" },
          { content: "Second task", status: "pending" },
        ],
      },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos).toEqual([
      { subject: "First task", status: "in_progress" },
      { subject: "Second task", status: "pending" },
    ]);
  });

  it("TaskCreate も todos 抽出の対象になる", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TaskCreate",
      input: {
        todos: [{ content: "Do something", status: "pending" }],
      },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos).toBeDefined();
    expect(result.todos![0].subject).toBe("Do something");
  });

  it("TaskUpdate も todos 抽出の対象になる", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TaskUpdate",
      input: {
        todos: [{ content: "Updated task", status: "done" }],
      },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos).toBeDefined();
  });

  it("subject フィールドがある場合もマッピングする", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TodoWrite",
      input: {
        todos: [{ subject: "Via subject field", status: "pending" }],
      },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos![0].subject).toBe("Via subject field");
  });

  it("todos が空配列の場合は undefined を返す", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TodoWrite",
      input: { todos: [] },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos).toBeUndefined();
  });

  it("todos に content も subject も無いエントリは無視する", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TodoWrite",
      input: {
        todos: [
          { status: "pending" }, // subject なし — 無視
          { content: "Valid task", status: "done" },
        ],
      },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos).toHaveLength(1);
    expect(result.todos![0].subject).toBe("Valid task");
  });

  it("status が文字列でない場合は 'pending' をデフォルトにする", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "TodoWrite",
      input: {
        todos: [{ content: "No status" }],
      },
    });
    const result = await claudeCodeProvider.parseTranscript(line);
    expect(result.todos![0].status).toBe("pending");
  });
});

describe("claudeCodeProvider.parseTranscript — 複合シナリオ", async () => {
  it("アシスタント・tool_use・TodoWrite が混在したトランスクリプト全体を解析できる", async () => {
    const lines = [
      JSON.stringify({ role: "user", content: "Do something" }),
      JSON.stringify({ type: "tool_use", name: "Bash", input: { command: "echo hi" }, ts: 1 }),
      JSON.stringify({
        type: "tool_use",
        name: "TodoWrite",
        input: { todos: [{ content: "Task A", status: "pending" }] },
      }),
      JSON.stringify({ role: "assistant", content: "Done!" }),
    ].join("\n");

    const result = await claudeCodeProvider.parseTranscript(lines);
    expect(result.jsonl_lines).toBe(4);
    expect(result.last_message_role).toBe("assistant");
    expect(result.last_text_summary).toBe("Done!");
    expect(result.last_tool_use?.tool).toBe("TodoWrite");
    expect(result.todos).toEqual([{ subject: "Task A", status: "pending" }]);
  });

  it("CRLF 改行でも正常に解析できる", async () => {
    const lines =
      JSON.stringify({ role: "assistant", content: "Hello" }) +
      "\r\n" +
      JSON.stringify({ type: "tool_use", name: "Edit", input: {} });
    const result = await claudeCodeProvider.parseTranscript(lines);
    expect(result.jsonl_lines).toBe(2);
    expect(result.last_text_summary).toBe("Hello");
    expect(result.last_tool_use?.tool).toBe("Edit");
  });
});
