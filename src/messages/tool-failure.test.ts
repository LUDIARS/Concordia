import { describe, expect, it } from "vitest";
import { buildToolFailureDetail, extractToolCommand } from "./tool-failure.js";

describe("実行内容の抽出", () => {
  it("Claude の JSON 入力から command を取る", () => {
    expect(extractToolCommand(JSON.stringify({ command: "npm test", description: "run tests" })))
      .toBe("npm test");
  });

  it("Codex の生コマンド行はそのまま返す", () => {
    expect(extractToolCommand("git status --short")).toBe("git status --short");
  });

  it("200 字で切られて壊れた JSON からも command を拾う", () => {
    // Lictor の previewJson は 200 字で切るので、 閉じ括弧が無い形が普通に届く。
    const truncated = '{"command":"npm run build && npm run typecheck","descripti';
    expect(extractToolCommand(truncated)).toBe("npm run build && npm run typecheck");
  });

  it("壊れた JSON のエスケープを戻す", () => {
    expect(extractToolCommand('{"command":"echo \\"hi\\"\\nls","desc')).toBe('echo "hi"\nls');
  });

  it("壊れた JSON でもリテラルのバックスラッシュと Unicode escape を正しく戻す", () => {
    const command = String.raw`printf \n ✓`;
    const encoded = JSON.stringify({ command, description: "x" }).replace("✓", "\\u2713");
    const truncated = encoded.slice(0, encoded.indexOf(',"description"'));
    expect(extractToolCommand(truncated)).toBe(command);
  });

  it("Bash 以外は代表フィールドを使う", () => {
    expect(extractToolCommand(JSON.stringify({ file_path: "E:/x/y.ts", old_string: "a" })))
      .toBe("E:/x/y.ts");
  });

  it("何も無ければ空文字 (取れないものを捏造しない)", () => {
    expect(extractToolCommand("")).toBe("");
    expect(extractToolCommand("   ")).toBe("");
  });

  it("代表フィールドが無い JSON はプレビューをそのまま出す", () => {
    expect(extractToolCommand('{"limit":5}')).toBe('{"limit":5}');
  });
});

describe("失敗の内訳", () => {
  it("コマンドとエラーを組にする", () => {
    expect(buildToolFailureDetail({
      tool: "Bash",
      inputPreview: '{"command":"npm test"}',
      resultPreview: "exit code 1",
    })).toEqual({ tool: "Bash", command: "npm test", error: "exit code 1" });
  });

  it("エラー出力だけでも返す (tool-use を失った場合)", () => {
    expect(buildToolFailureDetail({ tool: "", inputPreview: "", resultPreview: "boom" }))
      .toEqual({ tool: "", command: "", error: "boom" });
  });

  it("素材がまったく無ければ null", () => {
    expect(buildToolFailureDetail({ tool: "Bash", inputPreview: "", resultPreview: "" })).toBeNull();
  });

  it("コマンドとエラーの資格情報を伏せてから残す", () => {
    const detail = buildToolFailureDetail({
      tool: `Bash token=${"toolsecret"}`,
      inputPreview: JSON.stringify({ command: "deploy --token=supersecret" }),
      resultPreview: `401 for Bearer ${"abc123def"}`,
    });
    expect(detail?.tool).toBe("Bash token=[REDACTED]");
    expect(detail?.command).toBe("deploy --token=[REDACTED]");
    expect(detail?.error).toBe("401 for Bearer [REDACTED]");
  });

  it("長い出力は打ち切る (metadata を肥大させない)", () => {
    const detail = buildToolFailureDetail({
      tool: "Bash",
      inputPreview: "",
      resultPreview: "x".repeat(1000),
    });
    expect(detail?.error.length).toBeLessThanOrEqual(401);
    expect(detail?.error.endsWith("…")).toBe(true);
  });
});
