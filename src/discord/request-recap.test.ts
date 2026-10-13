import { describe, expect, it } from "vitest";
import { formatConsultRequestRecap, formatForumRequestRecap, REQUEST_RECAP_MAX_LENGTH } from "./request-recap.js";

describe("formatForumRequestRecap", () => {
  it("タイトルと本文をそのまま並べる", () => {
    const text = formatForumRequestRecap({ title: "ログイン画面の修正", body: "ボタンが押せない\n再現手順あり" });
    expect(text).toBe("📝 **依頼内容**\n**タイトル**: ログイン画面の修正\n**本文**:\nボタンが押せない\n再現手順あり");
  });

  it("メンションを壊して再掲する", () => {
    const text = formatForumRequestRecap({ title: "@everyone 告知", body: "<@123456> に確認 @here" });
    expect(text).not.toMatch(/@everyone|@here|<@123456>/);
    expect(text).toContain("everyone");
    expect(text).toContain("123456");
  });

  it("長い本文は上限に収め、省略を明示する", () => {
    const text = formatForumRequestRecap({ title: "t", body: "あ".repeat(5000) });
    expect(text.length).toBeLessThanOrEqual(REQUEST_RECAP_MAX_LENGTH);
    expect(text).toContain("以下省略");
    expect(text).toContain("**タイトル**: t");
  });

  it("空のタイトル・本文は空と分かるように書く", () => {
    expect(formatForumRequestRecap({ title: " ", body: "" })).toContain("(タイトルなし)");
    expect(formatForumRequestRecap({ title: "t", body: "  " })).toContain("(本文なし)");
  });
});

describe("formatConsultRequestRecap", () => {
  const intake = { topic: "DDD の集約の切り方", skill_level: "中級", role_title: "エンジニア", purpose: "" };

  it("部署・オプション・知りたいことを並べ、空の任意項目は未入力と書く", () => {
    const text = formatConsultRequestRecap({ departmentName: "技術相談課", intake });
    expect(text).toBe([
      "📝 **相談内容**",
      "**部署**: 技術相談課",
      "**技術レベル**: 中級",
      "**役職**: エンジニア",
      "**目的**: 未入力",
      "**知りたいこと**:",
      "DDD の集約の切り方",
    ].join("\n"));
  });

  it("部署名が無ければ部署の行を出さない", () => {
    expect(formatConsultRequestRecap({ departmentName: null, intake })).not.toContain("**部署**");
  });

  it("相談内容のメンションを壊し、長文は知りたいことだけを切り詰める", () => {
    const text = formatConsultRequestRecap({
      departmentName: "技術相談課",
      intake: { ...intake, role_title: "<@999>", topic: "@everyone " + "い".repeat(5000) },
    });
    expect(text).not.toMatch(/<@999>|@everyone/);
    expect(text.length).toBeLessThanOrEqual(REQUEST_RECAP_MAX_LENGTH);
    expect(text).toContain("**技術レベル**: 中級");
    expect(text).toContain("以下省略");
  });
});
