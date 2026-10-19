import { describe, expect, it } from "vitest";
import { consultationLifecycleGuidance } from "./lifecycle-guidance.js";

describe("consultationLifecycleGuidance", () => {
  it("distinguishes the private consultation deadline, channel and new session", () => {
    const guidance = consultationLifecycleGuidance();
    expect(guidance).toContain("24時間ぴったりではありません");
    expect(guidance).toContain("チャンネルと過去の投稿は残り");
    expect(guidance).toContain("相談者本人");
    expect(guidance).toContain("新しいセッションを起動");
    expect(guidance).toContain("再開時から数え直します");
    expect(guidance).toContain("公開フォーラムの相談は");
  });

  it("does not equate retained posts or remembered details with restored model history", () => {
    const guidance = consultationLifecycleGuidance();
    expect(guidance).toContain("会話全文・要約の自動読込みを保証しません");
    expect(guidance).toContain("全文か要約かを判別できません");
    expect(guidance).toContain("実際に終了・再開が起きた証拠ではありません");
    expect(guidance).toContain("未確認と伝え");
    expect(guidance).toContain("再提示を頼んでください");
  });
});
