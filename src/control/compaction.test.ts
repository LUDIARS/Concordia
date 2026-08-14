import { describe, it, expect, vi } from "vitest";
import {
  buildHandoffPrompt,
  buildSessionEndHandoffPrompt,
  buildSessionHandoverPrompt,
  elicitHandoffFromSession,
  generateHandoff,
  runCompaction,
  type CompactionDeps,
} from "./compaction.js";
import { ENTER_KEY_TEXT } from "./enter-key.js";

describe("buildHandoffPrompt", () => {
  it("current_task と参照指示 (チャンネル履歴を遡る) を含む", () => {
    const p = buildHandoffPrompt("Pictor の描画修正", "直近ログ");
    expect(p).toContain("Pictor の描画修正");
    expect(p).toContain("チャンネル");
    expect(p).toContain("次の一手");
  });
});

describe("buildSessionEndHandoffPrompt", () => {
  it("session-end 相当 + 実状優先 + current_task + clear 禁止を含む", () => {
    const p = buildSessionEndHandoffPrompt("ゴール体系の実装");
    expect(p).toContain("ゴール体系の実装");
    expect(p).toContain("実状を優先");
    expect(p).toContain("次の一手");
    // セッション自身が /clear しないよう明示する。
    expect(p).toContain("`/clear`");
    expect(p).toMatch(/しないで/);
  });
});

describe("buildSessionHandoverPrompt", () => {
  it("addresses the next session as a migration and does not claim /clear continuation", () => {
    const p = buildSessionHandoverPrompt("ゴール体系の実装");
    expect(p).toContain("次のセッション");
    expect(p).toContain("移行");
    expect(p).toContain("ゴール体系の実装");
    expect(p).not.toContain("`/clear` 後の自分自身");
  });
});

// transcript_logs を模したモック。 since_id より新しい frame だけ返す。
// baselineMaxId = inject 直前の watermark (frame はその後に「到着」する想定なので既定 0)。
function makeTranscript(
  frames: Array<{ id: number; kind: string; payload: unknown }> = [],
  baselineMaxId = 0,
) {
  return {
    listBySession: (_id: string, opts: { since_id?: number } = {}) =>
      frames.filter((f) => f.id > (opts.since_id ?? 0)),
    maxId: () => baselineMaxId,
    countBySession: () => frames.length,
  } as unknown as CompactionDeps["transcriptLogs"];
}

function assistantFrame(id: number, text: string) {
  return { id, kind: "text", payload: { role: "assistant", text } };
}

describe("elicitHandoffFromSession", () => {
  const timing = { sleep: async () => {}, elicitPollMs: 1, elicitQuietMs: 1, elicitTimeoutMs: 20 };

  it("inject 後に出た assistant 地の文を捕捉する (user エコーは除外)", async () => {
    const transcriptLogs = makeTranscript([
      { id: 1, kind: "text", payload: { role: "user", text: "プロンプトのエコー" } },
      assistantFrame(2, "### 現在のタスク\nゴール体系"),
    ]);
    const h = await elicitHandoffFromSession({ transcriptLogs, ...timing }, "s1", /* watermark */ 1);
    expect(h).toBe("### 現在のタスク\nゴール体系");
  });

  it("masks credentials before captured handoff text leaves the session", async () => {
    const credential = "credential-candidate";
    const transcriptLogs = makeTranscript([
      assistantFrame(2, ["Bearer", credential, ["token", credential].join("=")].join(" ")),
    ]);
    const h = await elicitHandoffFromSession({ transcriptLogs, ...timing }, "s1", 1);
    expect(h).toContain("[REDACTED]");
    expect(h).not.toContain(credential);
  });

  it("watermark 以前の frame は無視する", async () => {
    const transcriptLogs = makeTranscript([assistantFrame(5, "古い地の文")]);
    const h = await elicitHandoffFromSession({ transcriptLogs, ...timing }, "s1", 5);
    expect(h).toBeNull();
  });

  it("何も出なければ null (フォールバック誘発)", async () => {
    const h = await elicitHandoffFromSession({ transcriptLogs: makeTranscript([]), ...timing }, "s1", 0);
    expect(h).toBeNull();
  });
});

describe("generateHandoff", () => {
  it("LLM 成功時は出力をそのまま使う", async () => {
    const h = await generateHandoff({ runClaude: async () => ({ ok: true, stdout: "### 現在のタスク\nX", stderr: "" }) }, "t", "ctx");
    expect(h).toContain("### 現在のタスク");
  });
  it("LLM output credentials are masked", async () => {
    const credential = "credential-candidate";
    const h = await generateHandoff({
      runClaude: async () => ({
        ok: true,
        stdout: ["access_token", credential].join("="),
        stderr: "",
      }),
    }, "t", "ctx");
    expect(h).toBe("access_token=[REDACTED]");
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
    // 既定: セッションが自筆 handoff を出す (id=10 の assistant 地の文)。
    transcriptLogs: makeTranscript([assistantFrame(10, "### 現在のタスク\nセッション自筆の引き継ぎ")]),
    runClaude: async () => ({ ok: true, stdout: "### 現在のタスク\n切り離し生成", stderr: "" }),
    inject: async (_id, text, source) => { injects.push({ text, source }); return true; },
    postHandoff: async (_id, md) => { posts.push(md); },
    clearWaitMs: 0,
    sleep: async () => {},
    elicitPollMs: 1,
    elicitQuietMs: 1,
    elicitTimeoutMs: 20,
    ...overrides,
  };
  return { deps, injects, posts };
}

describe("runCompaction", () => {
  it("handoff 依頼→capture→投稿→/clear+Enter→再投入+Enter の順で処理する", async () => {
    const { deps, injects, posts } = makeDeps();
    const r = await runCompaction(deps, "s1");
    expect(r.ok).toBe(true);
    // セッション自筆の handoff が投稿される (切り離し生成ではない)。
    expect(posts[0]).toContain("📌");
    expect(posts[0]).toContain("セッション自筆の引き継ぎ");
    // inject 順: handoff 依頼, Enter, /clear, Enter, reinject, Enter。
    expect(injects.map((i) => i.source)).toEqual([
      "compaction-handoff-request",
      "compaction-handoff-request-enter",
      "compaction-clear",
      "compaction-clear-enter",
      "compaction-reinject",
      "compaction-reinject-enter",
    ]);
    expect(injects[0].text).toContain("session-end");
    expect(injects[2].text).toBe("/clear");
    expect(injects[3].text).toBe(ENTER_KEY_TEXT);
    expect(injects[4].text).toContain("引き継ぎ資料");
    expect(injects[4].text).toContain("セッション自筆の引き継ぎ");
    expect(deps.sessions.mergeMetadata).toHaveBeenCalled();
  });

  it("捕捉失敗時は切り離し生成 (generateHandoff) にフォールバックする", async () => {
    const warn = vi.fn();
    const { deps, posts } = makeDeps({
      transcriptLogs: makeTranscript([]), // セッションが何も出さない
      log: { info: vi.fn(), warn },
    });
    const r = await runCompaction(deps, "s1");
    expect(r.ok).toBe(true);
    expect(posts[0]).toContain("切り離し生成");
    expect(warn).toHaveBeenCalled();
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
    const { deps } = makeDeps({
      inject: async (_id, _text, source) => source !== "compaction-clear",
    });
    const r = await runCompaction(deps, "s1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("/clear");
  });
});
