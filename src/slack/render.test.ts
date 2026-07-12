import { describe, it, expect } from "vitest";
import {
  buildQuestionBlocks,
  buildSessionBotUsername,
  extractRelayableFrame,
  parseAnswerActionId,
  sanitizeSlackMentions,
  truncateForSlack,
  renderSessionCard,
  extractMonologue,
  slackReactionToUnicode,
  deriveTitleFromPost,
} from "./render.js";

describe("renderSessionCard", () => {
  it("active: text に engine + current_task + 返信ヒントを含む（フォールバック文字列）", () => {
    const { text } = renderSessionCard({
      who: "テスト魂", provider: "claude-code", model: "opus",
      currentTask: "Slack ライブカード実装", shortId: "abcd1234", status: "active",
    });
    expect(text).toContain("claude-code · opus");
    expect(text).toContain("📌 Slack ライブカード実装");
    expect(text).toContain("inject");
    expect(text).toContain("テスト魂"); // 返信ヒント行にのみ残る
  });
  it("active: blocks に Engine/Session の 2 カラムフィールドを含む", () => {
    const { blocks } = renderSessionCard({
      who: "テスト魂", provider: "claude-code", model: "opus",
      currentTask: "実装タスク", shortId: "abcd1234", status: "active",
    });
    const fieldsBlock = (blocks as Array<{ type: string; fields?: Array<{ text: string }> }>)
      .find((b) => b.type === "section" && Array.isArray(b.fields));
    expect(fieldsBlock).toBeDefined();
    const fieldTexts = fieldsBlock?.fields?.map((f) => f.text) ?? [];
    expect(fieldTexts.some((t) => t.includes("Engine"))).toBe(true);
    expect(fieldTexts.some((t) => t.includes("claude-code"))).toBe(true);
    expect(fieldTexts.some((t) => t.includes("Session"))).toBe(true);
    expect(fieldTexts.some((t) => t.includes("abcd1234"))).toBe(true);
  });
  it("active: current_task 空なら短縮 id を見出しに使う", () => {
    const { text, blocks } = renderSessionCard({ who: "X", shortId: "deadbeef", status: "active" });
    expect(text).toContain("📌 deadbeef");
    const taskBlock = (blocks as Array<{ type: string; text?: { text: string } }>)
      .find((b) => b.type === "section" && b.text?.text.includes("📌"));
    expect(taskBlock?.text?.text).toContain("deadbeef");
  });
  it("ended: text に ✅ Done + ポエム + 短縮id", () => {
    const { text } = renderSessionCard({ who: "X", shortId: "abcd1234", status: "ended", poem: "コードは残った\n次へ" });
    expect(text).toContain("✅ *Done*");
    expect(text).toContain("abcd1234");
    expect(text).toContain("コードは残った");
  });
  it("ended: blocks に divider とポエムを含む", () => {
    const { blocks } = renderSessionCard({ who: "X", shortId: "abcd1234", status: "ended", poem: "詩のテキスト" });
    const types = (blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types).toContain("divider");
    expect(types.filter((t) => t === "section").length).toBeGreaterThanOrEqual(2);
  });
  it("ended: ポエム無しでも既定文で落ちない", () => {
    const { text, blocks } = renderSessionCard({ who: "X", shortId: "abcd1234", status: "ended" });
    expect(text).toContain("✅ *Done*");
    expect(blocks.length).toBeGreaterThan(0);
  });
  it("active: 絵文字は body / blocks に含まれない（username フィールド行き）", () => {
    const { text, blocks } = renderSessionCard({ who: "X", emoji: "🧪", shortId: "abcd1234", status: "active" });
    expect(text.startsWith("🧪")).toBe(false);
    const json = JSON.stringify(blocks);
    expect(json).not.toContain("🧪 *X*");
  });
});

describe("buildSessionBotUsername", () => {
  it("絵文字あり: 絵文字 + スペース + ペルソナ名", () => {
    expect(buildSessionBotUsername({ who: "淵渡 一", emoji: "🧙", shortId: "x", status: "active" }))
      .toBe("🧙 淵渡 一");
  });
  it(":name: 形式絵文字も先頭に付く", () => {
    expect(buildSessionBotUsername({ who: "テスト魂", emoji: ":male_mage:", shortId: "x", status: "active" }))
      .toBe(":male_mage: テスト魂");
  });
  it("絵文字なしはペルソナ名のみ", () => {
    expect(buildSessionBotUsername({ who: "Concordia", shortId: "x", status: "active" }))
      .toBe("Concordia");
  });
  it("who が空なら Concordia にフォールバック", () => {
    expect(buildSessionBotUsername({ who: "", shortId: "x", status: "active" }))
      .toBe("Concordia");
  });
});

describe("deriveTitleFromPost", () => {
  it("先頭の非空行を 1 行タイトルにする", () => {
    expect(deriveTitleFromPost("Slack カードを実装する\n詳細は…")).toBe("Slack カードを実装する");
  });
  it("Markdown 見出し / 箇条書き記号 / 強調を削ぐ", () => {
    expect(deriveTitleFromPost("## **設計**を詰める")).toBe("設計を詰める");
    expect(deriveTitleFromPost("- やる事リスト")).toBe("やる事リスト");
  });
  it("先頭の空行を飛ばして最初の中身を採る", () => {
    expect(deriveTitleFromPost("\n\n  実装開始  \n次行")).toBe("実装開始");
  });
  it("max 超過は … で丸める", () => {
    expect(deriveTitleFromPost("あ".repeat(80), 10)).toBe(`${"あ".repeat(9)}…`);
  });
  it("空 / 記号だけは null", () => {
    expect(deriveTitleFromPost("")).toBeNull();
    expect(deriveTitleFromPost("\n\n")).toBeNull();
    expect(deriveTitleFromPost("###")).toBeNull();
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

  it("does not relay Codex commentary", () => {
    expect(extractRelayableFrame("text", {
      role: "assistant",
      phase: "commentary",
      text: "working",
    })).toBeNull();
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
  it("ask ブロックのみの本文は null（Slack に raw JSON を流さない）", () => {
    const askOnly = '```ask\n{"question":"どっち?","options":[{"label":"A"}]}\n```';
    expect(extractRelayableFrame("text", { role: "assistant", text: askOnly })).toBeNull();
  });
  it("ask ブロック + 散文 → ブロックを除去した散文を返す", () => {
    const mixed = '進め方を確認します。\n\n```ask\n{"question":"どっち?","options":[{"label":"A"}]}\n```';
    const r = extractRelayableFrame("text", { role: "assistant", text: mixed });
    expect(r).toEqual({ role: "assistant", text: "進め方を確認します。" });
  });
  it("summary の ask ブロックは除去しない（assistant のみ対象）", () => {
    const askBlock = '```ask\n{"question":"Q","options":[]}\n```';
    const r = extractRelayableFrame("summary", { text: askBlock });
    expect(r).toEqual({ role: "summary", text: askBlock });
  });
});

describe("sanitizeSlackMentions", () => {
  it("<!here> を @here に変換", () => {
    expect(sanitizeSlackMentions("注意 <!here> 全員へ")).toBe("注意 @here 全員へ");
  });
  it("<!channel> を @channel に変換", () => {
    expect(sanitizeSlackMentions("<!channel> お知らせです")).toBe("@channel お知らせです");
  });
  it("<!everyone> を @everyone に変換", () => {
    expect(sanitizeSlackMentions("<!everyone> 緊急です")).toBe("@everyone 緊急です");
  });
  it("<@USERID> を @USERID に変換", () => {
    expect(sanitizeSlackMentions("こんにちは <@U12345ABC>")).toBe("こんにちは @U12345ABC");
  });
  it("通常テキストは変更なし", () => {
    const normal = "普通の文章です。@here とか @channel は変換しない（既に @ だから）。";
    expect(sanitizeSlackMentions(normal)).toBe(normal);
  });
  it("複数のメンションを一括変換", () => {
    const t = "<!here> と <@UABCDEF> と <!channel> にも通知";
    expect(sanitizeSlackMentions(t)).toBe("@here と @UABCDEF と @channel にも通知");
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
    expect(actions?.elements?.map((e) => e.action_id)).toEqual(["cc_answer:42:0", "cc_answer:42:1", "cc_answer_other:42"]);
    expect(actions?.elements?.slice(0, 2).map((e) => e.value)).toEqual(["0", "1"]);
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
