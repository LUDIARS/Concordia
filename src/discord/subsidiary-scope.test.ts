import { describe, expect, it } from "vitest";
import {
  isSubsidiaryAllowedCommand,
  isSubsidiaryAllowedInteraction,
  isSubsidiarySessionSurface,
} from "./subsidiary-scope.js";

/** customId だけを持つ最小 interaction (dispatch は形で判定する)。 */
function surface(customId: string, opts: { button?: boolean } = {}) {
  return {
    type: 3,
    customId,
    isButton: () => opts.button ?? true,
    isAutocomplete: () => false,
    isRepliable: () => true,
  } as never;
}

describe("子会社 guild で使えるコマンド", () => {
  it("spawn と ch_name だけを許す", () => {
    expect(isSubsidiaryAllowedCommand("spawn")).toBe(true);
    expect(isSubsidiaryAllowedCommand("ch_name")).toBe(true);
  });

  it.each(["end-session", "ex-run", "ex-reboot", "prs", "co-relictor", "project-code"])(
    "本社運営のコマンド %s は出さない",
    (name) => {
      expect(isSubsidiaryAllowedCommand(name)).toBe(false);
    },
  );

  it("コマンド interaction はコマンド名で判定する", () => {
    expect(isSubsidiaryAllowedInteraction({ commandName: "spawn" } as never)).toBe(true);
    expect(isSubsidiaryAllowedInteraction({ commandName: "prs" } as never)).toBe(false);
  });
});

describe("子会社 guild で使える操作面", () => {
  it.each([
    ["q:12:0", "AskUserQuestion の選択"],
    ["qsel:12", "AskUserQuestion の 6 件以上の選択"],
    ["qmul:12", "AskUserQuestion の複数選択"],
    ["qoth:12", "AskUserQuestion のその他"],
    ["qothm:12", "AskUserQuestion のその他 modal"],
    ["perm:allow:tok", "セッションの許可要求"],
    ["context:compact:s1", "context 圧縮"],
    ["dirplan:approve:1", "プラン判断"],
    ["forum-spawn-approval:allow:tok", "Session forum の起動承認"],
    ["forum-spawn-intake:project:thread-1", "不足情報の回答"],
  ])("セッション面 %s は許す (%s)", (customId) => {
    expect(isSubsidiarySessionSurface(surface(customId))).toBe(true);
    expect(isSubsidiaryAllowedInteraction(surface(customId))).toBe(true);
  });

  it.each([
    ["ctrl:spawn:codex", "コントロールパネル"],
    ["ctrl:end-session", "コントロールパネル"],
    ["spawn-approval:allow:tok", "執行役員への一回許可 (本社のみ)"],
    ["pr:submit:s1", "PR 操作パネル"],
    ["team-admin:suspend:t1", "チーム管理"],
    ["test:start:surface-1", "Test forum の操作"],
  ])("本社運営の面 %s は出さない (%s)", (customId) => {
    expect(isSubsidiarySessionSurface(surface(customId, { button: false }))).toBe(false);
    expect(isSubsidiaryAllowedInteraction(surface(customId, { button: false }))).toBe(false);
  });

  it("customId を持たない interaction は面として許さない", () => {
    expect(isSubsidiarySessionSurface({ type: 1, isButton: () => false } as never)).toBe(false);
  });
});
