import { describe, it, expect } from "vitest";
import {
  resolveSessionId,
  resolvePromptText,
  resolveEditTarget,
} from "../tools/concordia-hook-resolver.mjs";

describe("concordia-hook resolveSessionId", () => {
  it("Lictor 配下: CONCORDIA_SESSION_ID が ctx.session_id / CLAUDE_SESSION_ID より優先される", () => {
    // 再現する状況: Lictor で wrap した Claude Code が hook を呼ぶとき、
    // ctx.session_id と CLAUDE_SESSION_ID には Claude 内部 UUID が入っており、
    // Concordia には登録されていない。 Lictor session ID のみが登録済。
    const ctx = { session_id: "claude-internal-uuid" };
    const env = {
      CONCORDIA_SESSION_ID: "lictor-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      CLAUDE_SESSION_ID: "claude-internal-uuid",
    };
    expect(resolveSessionId(ctx, env)).toBe(
      "lictor-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  it("非 Lictor: CONCORDIA_SESSION_ID 無し → ctx.session_id を使う", () => {
    const ctx = { session_id: "claude-uuid-1234" };
    const env = { CLAUDE_SESSION_ID: "claude-uuid-1234" };
    expect(resolveSessionId(ctx, env)).toBe("claude-uuid-1234");
  });

  it("ctx が空でも CLAUDE_SESSION_ID env から拾える", () => {
    const env = { CLAUDE_SESSION_ID: "claude-uuid-only-in-env" };
    expect(resolveSessionId(null, env)).toBe("claude-uuid-only-in-env");
  });

  it("どの source にも ID が無ければ null", () => {
    expect(resolveSessionId(null, {})).toBeNull();
    expect(resolveSessionId({}, {})).toBeNull();
  });

  it("ctx.session_id が空文字なら ?? は素通りして空文字を返す (既知の挙動 pin)", () => {
    // 空文字は nullish ではないので ?? の fallback には乗らない。
    // この挙動を変えたい (例: 空文字も fallback) ときはこのテストを更新すること。
    const ctx = { session_id: "" };
    const env = { CLAUDE_SESSION_ID: "claude-uuid-from-env" };
    expect(resolveSessionId(ctx, env)).toBe("");
  });

  it("env が undefined でも落ちない", () => {
    const ctx = { session_id: "claude-uuid-1234" };
    expect(resolveSessionId(ctx, undefined)).toBe("claude-uuid-1234");
  });
});

describe("concordia-hook resolvePromptText", () => {
  it("Claude Code は ctx.user_prompt を返す", () => {
    expect(resolvePromptText({ user_prompt: "hello claude" })).toBe("hello claude");
  });

  it("Codex CLI は ctx.prompt を返す", () => {
    expect(resolvePromptText({ prompt: "hello codex" })).toBe("hello codex");
  });

  it("両方あれば user_prompt 優先 (Claude が先に書く想定)", () => {
    expect(resolvePromptText({ user_prompt: "claude", prompt: "codex" })).toBe("claude");
  });

  it("どっちも無ければ空文字", () => {
    expect(resolvePromptText({})).toBe("");
    expect(resolvePromptText(null)).toBe("");
  });

  it("string でなければ空文字 (型ガード)", () => {
    expect(resolvePromptText({ user_prompt: 123 })).toBe("");
    expect(resolvePromptText({ prompt: { nested: "x" } })).toBe("");
  });
});

describe("concordia-hook resolveEditTarget", () => {
  it("Claude Edit/Write の file_path", () => {
    expect(resolveEditTarget({ tool_input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
  });

  it("Claude 旧表記の path", () => {
    expect(resolveEditTarget({ tool_input: { path: "/a/b.ts" } })).toBe("/a/b.ts");
  });

  it("Codex Bash の command", () => {
    expect(resolveEditTarget({ tool_input: { command: "rg foo" } })).toBe("rg foo");
  });

  it("優先順位 file_path > path > command", () => {
    expect(
      resolveEditTarget({
        tool_input: { file_path: "/a", path: "/b", command: "c" },
      }),
    ).toBe("/a");
    expect(
      resolveEditTarget({ tool_input: { path: "/b", command: "c" } }),
    ).toBe("/b");
  });

  it("tool_input なし / 不正型なら null", () => {
    expect(resolveEditTarget({})).toBeNull();
    expect(resolveEditTarget({ tool_input: null })).toBeNull();
    expect(resolveEditTarget({ tool_input: "not-object" })).toBeNull();
    expect(resolveEditTarget(null)).toBeNull();
  });
});
