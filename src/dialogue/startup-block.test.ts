import { describe, expect, it } from "vitest";
import { buildDialogueStartupBlock, MAX_LAUNCH_CORRECTION_CHARS, MAX_LAUNCH_CORRECTIONS } from "./startup-block.js";

const base = {
  departmentName: "技術相談課",
  useCase: { name: "技術相談", formatName: "一問一答 Q&A", summary: "質問に回答を返す。", preData: "- 結論を先に書く。" },
  corrections: [],
};

describe("buildDialogueStartupBlock", () => {
  it("lists the department, use case, summary and pre-data", () => {
    expect(buildDialogueStartupBlock(base)).toBe([
      "## 部署: 技術相談課 / ユースケース: 技術相談 (一問一答 Q&A)",
      "質問に回答を返す。",
      "",
      "### 事前データ",
      "- 結論を先に書く。",
    ].join("\n"));
  });

  it("adds corrections newest-first as single lines", () => {
    const block = buildDialogueStartupBlock({
      ...base,
      corrections: [
        { question: "DDD の利点", correction: "境界づけられた文脈で\n用語を揃えられる" },
        { question: "", correction: "集約は小さく保つ" },
      ],
    });
    expect(block).toContain("### これまでの訂正");
    expect(block).toContain("- 問: DDD の利点 / 訂正: 境界づけられた文脈で / 用語を揃えられる");
    expect(block).toContain("- 訂正: 集約は小さく保つ");
  });

  it("caps corrections by count and total characters (CC-DLG-INV-02)", () => {
    const many = Array.from({ length: MAX_LAUNCH_CORRECTIONS + 10 }, (_, index) => ({ question: "", correction: `訂正${index}` }));
    const lines = buildDialogueStartupBlock({ ...base, corrections: many }).split("\n").filter((line) => line.startsWith("- 訂正"));
    expect(lines).toHaveLength(MAX_LAUNCH_CORRECTIONS);
    expect(lines[0]).toBe("- 訂正: 訂正0");

    const long = Array.from({ length: 5 }, () => ({ question: "", correction: "あ".repeat(MAX_LAUNCH_CORRECTION_CHARS / 2) }));
    const longLines = buildDialogueStartupBlock({ ...base, corrections: long }).split("\n").filter((line) => line.startsWith("- 訂正"));
    expect(longLines).toHaveLength(1);
  });

  it("includes requester notes only when they carry content", () => {
    const withProfile = buildDialogueStartupBlock({
      ...base,
      requester: { displayName: "neco", skillLevel: "中級", activities: "Unity のゲーム開発", notes: "" },
    });
    expect(withProfile).toContain("### 依頼者について\n- 名前: neco\n- 技術者レベル: 中級\n- やっていること: Unity のゲーム開発");
    expect(withProfile).not.toContain("- メモ:");

    const nameOnly = buildDialogueStartupBlock({
      ...base,
      requester: { displayName: "neco", skillLevel: "", activities: "", notes: "" },
    });
    expect(nameOnly).not.toContain("依頼者について");
  });

  it("adds the consultation intake as the last section and marks an empty purpose", () => {
    const block = buildDialogueStartupBlock({
      ...base,
      intake: { topic: "DDD って何が良いの", skill_level: "初級", role_title: "デザイナー", purpose: "" },
    });
    expect(block.endsWith([
      "### 今回の相談 (この技術レベル・役職・目的に合わせた粒度で答える)",
      "- 知りたいこと: DDD って何が良いの",
      "- 技術レベル: 初級",
      "- 役職: デザイナー",
      "- 目的: (回答なし。知ること自体が目的として扱う)",
    ].join("\n"))).toBe(true);
    expect(buildDialogueStartupBlock({ ...base, intake: null })).not.toContain("今回の相談");
  });

  it("omits empty sections", () => {
    const block = buildDialogueStartupBlock({ ...base, useCase: { ...base.useCase, summary: " ", preData: "" } });
    expect(block).toBe("## 部署: 技術相談課 / ユースケース: 技術相談 (一問一答 Q&A)");
  });
});
