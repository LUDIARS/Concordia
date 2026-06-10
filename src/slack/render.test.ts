import { describe, it, expect } from "vitest";
import {
  buildQuestionBlocks,
  extractRelayableFrame,
  parseAnswerActionId,
  truncateForSlack,
  renderSessionCard,
  extractMonologue,
  slackReactionToUnicode,
} from "./render.js";

describe("renderSessionCard", () => {
  it("active: 使用AI + current_task + 返信ヒントを含む", () => {
    const t = renderSessionCard({
      who: "テスト魂", provider: "claude-code", model: "opus",
      currentTask: "Slack ライブカード実装", shortId: "abcd1234", status: "active",
    });
    expect(t).toContain("テスト魂");
    expect(t).toContain("claude-code · opus");
    expect(t).toContain("📌 Slack ライブカード実装");
    expect(t).toContain("inject");
  });
  it("active: current_task 空なら短縮 id を見出しに使う", () => {
    const t = renderSessionCard({ who: "X", shortId: "deadbeef", status: "active" });
    expect(t).toContain("📌 deadbeef");
  });
  it("ended: ✅ Done + ポエム + 短縮id", () => {
    const t = renderSessionCard({ who: "X", shortId: "abcd1234", status: "ended", poem: "コードは残った\n次へ" });
    expect(t).toContain("✅ *Done*");
    expect(t).toContain("abcd1234");
    expect(t).toContain("コードは残った");
  });
  it("ended: ポエム無しでも既定文で落ちない", () => {
    const t = renderSessionCard({ who: "X", shortId: "abcd1234", status: "ended" });
    expect(t).toContain("✅ *Done*");
    expect(t.length).toBeGreaterThan(10);
  });
});

describe("extractMonologue", () => {
  it("最初の --- より前の poem を返す", () => {
    const poem = "静かな夜だった。コードは流れ、テストは緑に灯った。";
    expect(extractMonologue(`${poem}\n---\n## 業務報告\n…`)).toBe(poem);
  });
  it("10文字未満の poem は null（業務報告だけの誤検出を防ぐ）", () => {
    expect(extractMonologue("短い\n---\n本文")).toBeNull();
  });
  it("--- が無ければ null", () => {
    expect(extractMonologue("区切りのない文章だけ")).toBeNull();
  });
  it("空 / 未定義は null", () => {
    expect(extractMonologue(null)).toBeNull();
    expect(extractMonologue(undefined)).toBeNull();
  });
});

describe("slackReactionToUnicode", () => {
  it("thumbsup / +1 → 👍", () => {
    expect(slackReactionToUnicode("thumbsup")).toBe("👍");
    expect(slackReactionToUnicode("+1")).toBe("👍");
  });
  it("skin-tone 接尾を除去して解決", () => {
    expect(slackReactionToUnicode("+1::skin-tone-3")).toBe("👍");
  });
  it("white_check_mark → ✅ / memo → 📝 / -1 → 👎", () => {
    expect(slackReactionToUnicode("white_check_mark")).toBe("✅");
    expect(slackReactionToUnicode("memo")).toBe("📝");
    expect(slackReactionToUnicode("-1")).toBe("👎");
  });
  it("ワークフロー対象外は null", () => {
    expect(slackReactionToUnicode("tada")).toBeNull();
    expect(slackReactionToUnicode("")).toBeNull();
  });
});

describe("extractRelayableFrame", () => {
  it("kind=text & role=assistant は中継対象", () => {
    const r = extractRelayableFrame("text", { role: "assistant", text: "hello" });
    expect(r).toEqual({ role: "assistant", text: "hello" });
  });
  it("kind=text & role=user は中継しない", () => {
    expect(extractRelayableFrame("text", { role: "user", text: "hi" })).toBeNull();
  });
  it("kind=summary は中継対象（text/summary どちらのキーでも）", () => {
    expect(extractRelayableFrame("summary", { text: "S1" })).toEqual({ role: "summary", text: "S1" });
    expect(extractRelayableFrame("summary", { summary: "S2" })).toEqual({ role: "summary", text: "S2" });
  });
  it("tool-use / thinking / raw は中継しない", () => {
    expect(extractRelayableFrame("tool-use", { name: "Bash" })).toBeNull();
    expect(extractRelayableFrame("thinking", { preview: "..." })).toBeNull();
    expect(extractRelayableFrame("raw", { type: "x" })).toBeNull();
  });
  it("空 text は中継しない", () => {
    expect(extractRelayableFrame("text", { role: "assistant", text: "" })).toBeNull();
    expect(extractRelayableFrame("summary", {})).toBeNull();
  });
});

describe("buildQuestionBlocks", () => {
  it("各選択肢を action_id=cc_answer:<qid>:<index> のボタンにする", () => {
    const { text, blocks } = buildQuestionBlocks(42, "Which?", [
      { label: "A", description: "do a" },
      "B",
    ]);
    expect(text).toContain("Which?");
    const actions = (blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>).find(
      (b) => b.type === "actions",
    );
    expect(actions?.elements?.map((e) => e.action_id)).toEqual(["cc_answer:42:0", "cc_answer:42:1"]);
    expect(actions?.elements?.map((e) => e.value)).toEqual(["0", "1"]);
  });
});

describe("parseAnswerActionId", () => {
  it("正しい action_id を解析", () => {
    expect(parseAnswerActionId("cc_answer:42:1")).toEqual({ questionId: 42, answerIndex: 1 });
  });
  it("prefix 不一致 / 形式不正は null", () => {
    expect(parseAnswerActionId("other:1:2")).toBeNull();
    expect(parseAnswerActionId("cc_answer:42")).toBeNull();
    expect(parseAnswerActionId("cc_answer:x:1")).toBeNull();
    expect(parseAnswerActionId("cc_answer:42:-1")).toBeNull();
    expect(parseAnswerActionId("")).toBeNull();
  });
});

describe("truncateForSlack", () => {
  it("上限超過は末尾を … に置換", () => {
    expect(truncateForSlack("abcdef", 4)).toBe("abc…");
    expect(truncateForSlack("ab", 4)).toBe("ab");
  });
});
