import { describe, expect, it } from "vitest";
import { buildInstructionPost, detailBlock, INSTRUCTION_POST_MAX_CHARS, neutralizeLine } from "./instruction-posts.js";

const id = "inst:muse:20261123T000000Z:abcdef";
const fence = "`".repeat(3);

describe("指令チャンネルの文 (CC-INST-INV-09)", () => {
  it("registered: id・宛先・種類・題・本文の要約 (300 文字)・作成時刻。 返信先は無い", () => {
    const post = buildInstructionPost({ kind: "registered", id, agent: "muse", type: "run_task", title: "件名", body: "あ".repeat(400), createdAt: "2026-11-23T00:00:00Z" });
    expect(post.replyTo).toBeNull();
    expect(post.content).toContain("指令を出しました");
    expect(post.content).toContain("`" + id + "`");
    expect(post.content).toContain("宛先: Muse / 種類: run_task / 作成: 2026-11-23T00:00:00Z");
    expect(post.content).toContain("題: 件名");
    expect(post.content).toContain("> " + "あ".repeat(299) + "…");
    expect(post.content).not.toContain("あ".repeat(300));
  });

  it("acked / requeued reply to the registration post and name the agent", () => {
    expect(buildInstructionPost({ kind: "acked", id, agent: "muse", title: "t", ackedAt: "2026-11-23T00:01:00Z" }))
      .toEqual({ content: "📥 Muse が受け取りました `" + id + "` (2026-11-23T00:01:00Z)", replyTo: id });
    const dots = buildInstructionPost({ kind: "acked", id: "inst:dots:20261123T000000Z:abcdef", agent: "dots", title: "t", ackedAt: "x" });
    expect(dots.content).toContain("dots が受け取りました");
    const requeued = buildInstructionPost({ kind: "requeued", id, agent: "muse", title: "t" });
    expect(requeued.replyTo).toBe(id);
    expect(requeued.content).toContain("30 分");
  });

  it("finished: status・要約・詳細 (JSON コードブロック 1500 文字まで)、 全体は投稿の上限に収まる", () => {
    const detail = JSON.stringify({ log: "x".repeat(5000) });
    const post = buildInstructionPost({ kind: "finished", id, agent: "muse", title: "t".repeat(200), status: "failed", summary: "s".repeat(400), detail, finishedAt: "2026-11-23T00:02:00Z" });
    expect(post.replyTo).toBe(id);
    expect(post.content).toContain("❌ **Muse の回答**");
    expect(post.content).toContain("— failed (2026-11-23T00:02:00Z)");
    expect(post.content).toContain(fence + "json\n");
    expect(post.content.endsWith("\n" + fence)).toBe(true);
    expect(post.content.length).toBeLessThanOrEqual(INSTRUCTION_POST_MAX_CHARS);
    const done = buildInstructionPost({ kind: "finished", id, agent: "dots", title: "t", status: "done", summary: "ok", detail: null, finishedAt: "x" });
    expect(done.content).toContain("✅ **dots の回答**");
    expect(done.content).not.toContain(fence);
  });

  it("neutralizes mentions and links from untrusted text, and keeps the code block closed", () => {
    const post = buildInstructionPost({
      kind: "finished", id, agent: "muse", title: "@everyone <@123>", status: "done",
      summary: "see https://evil.example @here", detail: JSON.stringify({ x: fence + "\n@everyone" }), finishedAt: "x",
    });
    expect(post.content).not.toMatch(/@everyone|@here|<@123>|https:\/\//u);
    expect(post.content.split(fence).length - 1).toBe(2);
    expect(neutralizeLine("a\n\nb  c", 10)).toBe("a b c");
    expect(detailBlock("not json", 100)).toBe(fence + "json\nnot json\n" + fence);
    expect(detailBlock(null, 100)).toBeNull();
  });
});
