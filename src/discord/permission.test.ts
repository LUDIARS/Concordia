import { describe, expect, it } from "vitest";
import { summarizeToolInput } from "./permission.js";

describe("summarizeToolInput", () => {
  it("Bash/PowerShell はコマンド本文のみ、 2 行 / 200 字に丸める", () => {
    const long = Array.from({ length: 6 }, (_, i) => `line${i + 1} $x = Get-Something`).join("\n");
    const out = summarizeToolInput("PowerShell", { command: long, description: "desc" });
    expect(out.split("\n")).toHaveLength(3); // 2 行 + 省略記号
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("line1");
    expect(out).toContain("line2");
    expect(out).not.toContain("line3");
  });

  it("200 字超の 1 行コマンドは文字数で丸める", () => {
    const out = summarizeToolInput("Bash", { command: "x".repeat(500) });
    expect(out.length).toBeLessThanOrEqual(201); // 200 + …
    expect(out.endsWith("…")).toBe(true);
  });

  it("Edit/Write はファイルパスのみ (本文は載せない)", () => {
    const out = summarizeToolInput("Write", {
      file_path: "E:/Document/Ars/Concordia/src/app.ts",
      content: "very long body\n".repeat(100),
    });
    expect(out).toBe("E:/Document/Ars/Concordia/src/app.ts");
  });

  it("WebFetch は URL、 WebSearch は query", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com/x" })).toBe("https://example.com/x");
    expect(summarizeToolInput("WebSearch", { query: "concordia perf" })).toBe("concordia perf");
  });

  it("未知ツールは代表フィールド → 無ければ 1 行 JSON", () => {
    expect(summarizeToolInput("SomeTool", { command: "run it" })).toBe("run it");
    const out = summarizeToolInput("SomeTool", { a: 1 });
    expect(out).toBe('{"a":1}');
  });

  it("要点フィールドが無い/空なら 1 行 JSON に落ちる", () => {
    expect(summarizeToolInput("Bash", {})).toBe("{}");
    expect(summarizeToolInput("Bash", { command: "  " })).toBe('{"command":"  "}');
    expect(summarizeToolInput("Bash", null)).toBe("null");
  });
});
