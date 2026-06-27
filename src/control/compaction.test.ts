import { describe, it, expect, vi } from "vitest";
import { buildHandoffPrompt, generateHandoff, runCompaction, type CompactionDeps } from "./compaction.js";
import { ENTER_KEY_TEXT } from "./enter-key.js";

describe("buildHandoffPrompt", () => {
  it("current_task と参照指示 (チャンネル履歴を遡る) を含む", () => {
    const p = buildHandoffPrompt("Pictor の描画修正", "直近ログ");
    expect(p).toContain("Pictor の描画修正");
    expect(p).toContain("チャンネル");
    expect(p).toContain("次の一手");
  });
});

describe("generateHandoff", () => {
  it("LLM 成功時は出力をそのまま使う", async () => {
    const h = await generateHandoff({ runClaude: async () => ({ ok: true, stdout: "### 現在のタスク\nX", stderr: "" }) }, "t", "ctx");
    expect(h).toContain("### 現在のタスク");
  });
  it("LLM 失敗時はフォールバック資料 (空にしない)", async () => {
    const h = await generateHandoff({ runClaude: async () => ({ ok: false, stdout: "", stderr: "boom" }) }, "タスクA", "ctx");
    expect(h).toContain("タスクA");
    expect(h).toContain("チャンネル");
  });
  it("LLM 例外時もフォールバック", async () => {
    const h = await generateHandoff({ runClaude: async () => { throw new Error("net"); } }, "タスクB", "");
    expect(h).toContain("タスクB");
  });
});

function makeDeps(overrides: Partial<CompactionDeps> = {}) {
  const injects: Array<{ text: string; source: string }> = [];
  const posts: string[] = [];
  const deps: CompactionDeps = {
    sessions: {
      findSession: () => ({ id: "s1", status: "active", current_task: "タスク", metadata: null }),
      mergeMetadata: vi.fn(),
    } as unknown as CompactionDeps["sessions"],
    transcriptLogs: { listBySession: () => [] } as unknown as CompactionDeps["transcriptLogs"],
    runClaude: async () => ({ ok: true, stdout: "### 現在のタスク\nやること", stderr: "" }),
    inject: async (_id, text, source) => { injects.push({ text, source }); return true; },
    postHandoff: async (_id, md) => { posts.push(md); },
    clearWaitMs: 0,
    sleep: async () => {},
    ...overrides,
  };
  return { deps, injects, posts };
}

describe("runCompaction", () => {
  it("投稿→/clear+Enter→再投入+Enter の順で処理する", async () => {
    const { deps, injects, posts } = makeDeps();
    const r = await runCompaction(deps, "s1");
    expect(r.ok).toBe(true);
    // 投稿に 📌 引き継ぎ資料。
    expect(posts[0]).toContain("📌");
    // inject 順: /clear, Enter, reinject, Enter。
    expect(injects.map((i) => i.source)).toEqual([
      "compaction-clear",
      "compaction-clear-enter",
      "compaction-reinject",
      "compaction-reinject-enter",
    ]);
    expect(injects[0].text).toBe("/clear");
    expect(injects[1].text).toBe(ENTER_KEY_TEXT);
    expect(injects[2].text).toContain("引き継ぎ資料");
    // last_compaction_at を記録。
    expect(deps.sessions.mergeMetadata).toHaveBeenCalled();
  });

  it("active でないセッションは error", async () => {
    const { deps } = makeDeps({
      sessions: { findSession: () => ({ id: "s1", status: "ended" }), mergeMetadata: vi.fn() } as unknown as CompactionDeps["sessions"],
    });
    const r = await runCompaction(deps, "s1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ended");
  });

  it("/clear inject 失敗なら ok=false", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      inject: async (_id, _text, source) => { calls.push(source); return source !== "compaction-clear"; },
    });
    const r = await runCompaction(deps, "s1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("/clear");
  });
});
