import { describe, it, expect } from "vitest";
import { parseSlashCommand } from "./render.js";
import { formatStat, formatHelp } from "./slash.js";

describe("parseSlashCommand", () => {
  it("空は help", () => {
    expect(parseSlashCommand("")).toEqual({ sub: "help", args: "" });
    expect(parseSlashCommand("   ")).toEqual({ sub: "help", args: "" });
  });
  it("単語のみ", () => {
    expect(parseSlashCommand("stat")).toEqual({ sub: "stat", args: "" });
    expect(parseSlashCommand("PRS")).toEqual({ sub: "prs", args: "" });
  });
  it("sub + args", () => {
    expect(parseSlashCommand("spawn claude E:/x")).toEqual({ sub: "spawn", args: "claude E:/x" });
  });
});

describe("formatStat", () => {
  it("空はメッセージ", () => {
    expect(formatStat([])).toContain("ありません");
  });
  it("session_id 8桁 + status + task を行にする", () => {
    const out = formatStat([
      { session_id: "abcdefgh1234", session: { status: "active", current_task: "やること" } },
      { session_id: "zzzz", session: { status: "lost", current_task: null, branch: "feat/x" } },
    ]);
    expect(out).toContain("abcdefgh");
    expect(out).toContain("active");
    expect(out).toContain("やること");
    expect(out).toContain("feat/x"); // task 無し → branch fallback
  });
});

describe("formatHelp", () => {
  it("stat / prs を案内", () => {
    const h = formatHelp();
    expect(h).toContain("/concordia stat");
    expect(h).toContain("/concordia prs");
  });
});
