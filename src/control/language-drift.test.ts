import { describe, expect, it } from "vitest";
import { isJapaneseProse, judgeLanguageDrift, proseOf } from "./language-drift.js";

describe("judgeLanguageDrift (CC-LANG-INV-01)", () => {
  it("flags an English working note", () => {
    const text = "Checking current state for neco's status request; first fixing the session's task registration so the gate lets commands through.";
    expect(judgeLanguageDrift(text).english).toBe(true);
  });

  it("flags English prose that quotes Japanese names", () => {
    const text = "I created サービス事務課 and linked the new use case to it. The department now handles service start, stop, install, status checks and UI tweaks as requested.";
    expect(judgeLanguageDrift(text).english).toBe(true);
  });

  it("keeps Japanese prose with English technical terms", () => {
    expect(judgeLanguageDrift("Castra は「ローカル main へ直接コミット」の経路でした。ブランチも PR も作らない運用です。").english).toBe(false);
    const quotedError = "Revisor の err ログには local_pr_merge_failed と .revisor-version must be committed on the base branch before publishing が出ています。";
    expect(judgeLanguageDrift(quotedError).english).toBe(false);
  });

  it("does not count code, urls and paths as prose", () => {
    const text = [
      "設定を直しました。",
      "```ts",
      "export function createPrivateChannelProvisioner(deps: PrivateChannelProvisionerDeps): PrivateChannelProvisioner { return deps; }",
      "```",
      "`POST /v1/discord/private-channels` と https://github.com/LUDIARS/Concordia/pull/2202 を参照。",
      "E:/Document/Ars/Concordia/src/discord/private-channel-provisioner.ts",
    ].join("\n");
    expect(proseOf(text)).not.toMatch(/createPrivateChannelProvisioner|github|private-channel-provisioner/);
    expect(judgeLanguageDrift(text).english).toBe(false);
  });

  it("keeps the Japanese next to a path or url written without spaces", () => {
    expect(proseOf("詳しくはhttps://example.com/aを参照し、起動/停止/再起動はExcubitor経由で行います。"))
      .toContain("を参照し、起動");
  });

  it("leaves short replies undecided", () => {
    expect(judgeLanguageDrift("OK, done.").english).toBe(false);
  });
});

describe("isJapaneseProse", () => {
  it("is true for Japanese sentences and false for English or empty text", () => {
    expect(isJapaneseProse("日本語に戻しました。続きを進めます。")).toBe(true);
    expect(isJapaneseProse("Back to the task, continuing with the build now.")).toBe(false);
    expect(isJapaneseProse("```\ncode only\n```")).toBe(false);
  });
});
