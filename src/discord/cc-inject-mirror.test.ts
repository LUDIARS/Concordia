import { describe, expect, it } from "vitest";
import {
  CC_INJECT_MIRROR_MAX_USERNAME,
  CC_INJECT_SUMMARY_MAX,
  STALL_NUDGE_INJECT_SOURCE,
  ccInjectMirrorPost,
  summarizeCcInject,
} from "./cc-inject-mirror.js";

describe("ccInjectMirrorPost", () => {
  it.each([
    "session-work-policy",
    "testing-traffic",
    "delegation:run-1:status",
  ])("mirrors Cc-originated inject (source=%s)", (source) => {
    expect(ccInjectMirrorPost({ source, text: "  hello  " })).toEqual({
      username: `⚙️ Cc inject / ${source}`,
      content: "hello",
    });
  });

  it("labels a missing source as unknown", () => {
    expect(ccInjectMirrorPost({ source: undefined, text: "x" })?.username).toBe("⚙️ Cc inject / unknown");
    expect(ccInjectMirrorPost({ source: "", text: "x" })?.username).toBe("⚙️ Cc inject / unknown");
  });

  it.each(["discord", "discord-enter", "discord:123456789012345678"])(
    "skips Discord-originated inject (source=%s)",
    (source) => {
      expect(ccInjectMirrorPost({ source, text: "hi" })).toBeNull();
    },
  );

  it("skips Slack human inject (mirrored by the existing Slack path)", () => {
    expect(ccInjectMirrorPost({ source: "slack:U123", text: "hi" })).toBeNull();
  });

  it.each(["delegation:run-1:followup", "delegation:run-1:parent", "delegation:run-1:followup-memoria"])(
    "skips delegation task body inject (source=%s)",
    (source) => {
      expect(ccInjectMirrorPost({ source, text: "task" })).toBeNull();
    },
  );

  it("skips stall nudge inject", () => {
    expect(STALL_NUDGE_INJECT_SOURCE).toBe("auto:stall-nudge");
    expect(ccInjectMirrorPost({ source: STALL_NUDGE_INJECT_SOURCE, text: "nudge" })).toBeNull();
  });

  it("skips control inject (Enter key) and blank text", () => {
    expect(ccInjectMirrorPost({ source: "session-work-policy", text: "\r" })).toBeNull();
    expect(ccInjectMirrorPost({ source: "session-work-policy", text: "  \n " })).toBeNull();
  });

  it("posts a one-line summary instead of the full body", () => {
    const post = ccInjectMirrorPost({
      source: "testing-traffic",
      text: "⚠️ ブランチ切替を検知しました (main → feat/x)。\n再起動・起動テストは Excubitor 経由で…\n現在テスト中のサービスはありません。",
    });
    expect(post?.content).toBe("⚠️ ブランチ切替を検知しました (main → feat/x)。");
  });

  it("keeps the notice within the summary limit for a long body", () => {
    const post = ccInjectMirrorPost({ source: "auto:inquiry", text: "a".repeat(2500) });
    expect(post?.content).toBe(`${"a".repeat(CC_INJECT_SUMMARY_MAX - 1)}…`);
  });

  it("caps username at 80 characters", () => {
    const post = ccInjectMirrorPost({ source: `reaction:${"x".repeat(200)}`, text: "hi" });
    expect(post?.username.length).toBe(CC_INJECT_MIRROR_MAX_USERNAME);
    expect(post?.username.startsWith("⚙️ Cc inject / reaction:")).toBe(true);
  });
});

describe("summarizeCcInject", () => {
  // 代表文面は各 inject の組み立て元 (ラベルのファイル) と同じ形。
  it.each([
    [
      "policy update (src/control/startup-policy.ts)",
      "[Cc policy update]\nrepo: E:/Document/Ars/Concordia\nbranch: main\nworkPolicy: 作業ポリシー本文\n- 箇条書き\n必須設定は実行許可を追加しません。\n[Cc policy revision: abc123]",
      "Cc policy update: repo / branch / workPolicy",
    ],
    [
      "policy update with a withdrawal notice (src/control/startup-policy.ts)",
      "[Cc policy update]\n過去の起動案内に含まれるワークフロー判定・提出手順は無効です。\nprocess: 手順\nprocess: 重複\n必須設定は実行許可を追加しません。\n[Cc policy revision: abc123]",
      "Cc policy update: process",
    ],
    [
      "project rules (src/control/project-rules-inject.ts)",
      "[Cc project rules] Cc (E:/Document/Ars/Concordia)\nこのセッションの作業対象にこのプロジェクトが加わりました。\n\n## CLAUDE.md — CLAUDE.md\n本文",
      "Cc project rules: Cc (E:/Document/Ars/Concordia)",
    ],
    [
      "branch switch (src/testing/branch-watch.ts)",
      "⚠️ ブランチ切替を検知しました (main → feat/x)。\n再起動・起動テストは Excubitor 経由で…\n  POST http://127.0.0.1:11111/v1/testing/claim {}",
      "⚠️ ブランチ切替を検知しました (main → feat/x)。",
    ],
    [
      "testing traffic conflict (src/testing/notify.ts via src/api/testing.ts)",
      "⚠️ テスト交通整備: サービス「Cc」は現在 s-1 (note なし) もテスト中です。競合しないよう調整してください。",
      "⚠️ テスト交通整備: サービス「Cc」は現在 s-1 (note なし) もテスト中です。競合しないよう調整してください。",
    ],
    [
      "goal-and-go (src/control/goal-and-go.ts)",
      "[Concordia goal-and-go 1/3]\n人間から新しい入力がないため、自走継続の判断を行ってください。\n明示ゴールは登録されていません。",
      "Concordia goal-and-go 1/3: 人間から新しい入力がないため、自走継続の判断を行ってください。",
    ],
    [
      "session followup (src/control/session-followup-state.ts)",
      "[自動確認] Cc の作業状態に応じた確認です。\nworkflow=cc; state=unknown\nActio タスクの現状態を正本として確認し…",
      "自動確認: Cc の作業状態に応じた確認です。",
    ],
  ])("summarizes %s into one line", (_label, text, expected) => {
    expect(summarizeCcInject(text)).toBe(expected);
  });

  it("lists at most five keys and marks the rest with ほか", () => {
    const text = ["[Cc policy update]", "a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6"].join("\n");
    expect(summarizeCcInject(text)).toBe("Cc policy update: a / b / c / d / e ほか");
  });

  it("uses the tag alone when nothing follows it", () => {
    expect(summarizeCcInject("  [Cc policy update]  \n\n  ")).toBe("Cc policy update");
  });

  it("collapses whitespace and skips leading blank lines", () => {
    expect(summarizeCcInject("\n\n   hello\t\t  world  \nnext")).toBe("hello world");
    expect(summarizeCcInject("line one\r\nline two")).toBe("line one");
  });

  it("truncates to 149 characters plus an ellipsis past the limit", () => {
    expect(summarizeCcInject("x".repeat(CC_INJECT_SUMMARY_MAX))).toBe("x".repeat(CC_INJECT_SUMMARY_MAX));
    const long = summarizeCcInject("y".repeat(CC_INJECT_SUMMARY_MAX + 1));
    expect(Array.from(long)).toHaveLength(CC_INJECT_SUMMARY_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

