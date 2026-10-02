import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { launchCwdFromLines, readConversationLaunch } from "./conversation-launch.js";

describe("launchCwdFromLines", () => {
  it("transcript の先頭で最初に出た cwd を会話を始めた場所とする", () => {
    expect(launchCwdFromLines([
      JSON.stringify({ type: "mode" }),
      JSON.stringify({ cwd: "E:\\Document\\Ars" }),
      JSON.stringify({ cwd: "E:\\Document\\Ars\\Concordia-wt" }),
    ])).toBe("E:\\Document\\Ars");
    expect(launchCwdFromLines(["broken"])).toBeNull();
  });
});

describe("readConversationLaunch", () => {
  it("claude 以外は会話 id を持たず、 読めない transcript はセッションの repo_path に倒す", async () => {
    const base = { id: "s1", repo_path: "E:/repo", metadata: null } as unknown as SessionRow;
    expect(await readConversationLaunch({ ...base, provider: "codex-cli", transcript_path: null }))
      .toEqual({ conversationId: null, cwd: "E:/repo" });
    expect(await readConversationLaunch({
      ...base, provider: "claude-code", transcript_path: "C:/nowhere/9914dcf2-7e21-4fcd-96ae-7dfe7c64d662.jsonl",
    })).toEqual({ conversationId: "9914dcf2-7e21-4fcd-96ae-7dfe7c64d662", cwd: "E:/repo" });
  });
});
