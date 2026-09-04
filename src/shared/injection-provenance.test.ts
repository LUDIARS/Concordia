/**
 * 注入された指示の出所 (provenance) が、注入経路から session message の正本まで
 * 失われないことの回帰テスト。
 *
 * reaction workflow は絵文字 1 つを指示文へ展開する。その結果できた message が
 * ユーザーの直接入力と区別できないと、(1) モデルが機械生成のテンプレートを本人の
 * 指示と同じ重みで読む、(2) 誤爆の調査ができない、の 2 つが起きる。
 */

import { describe, expect, it } from "vitest";
import { projectEvent } from "../messages/project.js";
import type { InjectionProvenance } from "./injection-provenance.js";

const PROVENANCE: InjectionProvenance = {
  kind: "reaction-workflow",
  action: "handoff-document",
  platform: "discord",
  emoji: "👋",
  sourceMessageId: "msg-1",
  actorId: "user-1",
};

function injectEvent(provenance?: InjectionProvenance) {
  return {
    type: "session.inject" as const,
    target_session_id: "sess-1",
    text: "引継ぎ資料を作成してください。",
    source: "reaction-workflow",
    ...(provenance ? { provenance } : {}),
    ts: 1,
  };
}

const CTX = { toolUse: { get: () => undefined, set: () => undefined } } as never;

describe("注入の出所", () => {
  it("provenance のある注入は user と区別できる形で正本へ落ちる", () => {
    const [message] = projectEvent(injectEvent(PROVENANCE), CTX);

    // ユーザーの直接入力と同じ author_type にすると、モデルへ渡す入力で混ざる。
    expect(message.op).toBe("create");
    if (message.op !== "create") return;
    expect(message.author_type).not.toBe("user");
    expect(message.author_label).toContain("handoff-document");
    expect(message.author_platform).toBe("discord");
    // projector は受け取った本文を追加加工せず、実際にモデルへ送った内容を正本にする。
    expect(message.content).toBe("引継ぎ資料を作成してください。");
  });

  it("action / platform と発火元の非可逆 reference が metadata まで届く", () => {
    const [message] = projectEvent(injectEvent(PROVENANCE), CTX);

    expect(message.metadata).toMatchObject({
      injection: {
        kind: "reaction-workflow",
        action: "handoff-document",
        platform: "discord",
        emoji: "👋",
      },
    });
    const injection = message.metadata?.injection as Record<string, unknown>;
    expect(injection.source_message_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(injection.actor_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(injection.source_message_ref).not.toBe(injection.actor_ref);
    expect(JSON.stringify(message.metadata)).not.toContain("msg-1");
    expect(JSON.stringify(message.metadata)).not.toContain("user-1");
  });

  it("provenance の無い注入は従来どおり user のまま", () => {
    // 出所を名乗れない注入 (delegation の中継など) の挙動を変えない。
    const [message] = projectEvent(injectEvent(), CTX);

    expect(message.op).toBe("create");
    if (message.op !== "create") return;
    expect(message.author_type).toBe("user");
    expect(message.author_label).toBe("User");
    expect(message.metadata).toBeUndefined();
  });

  it("Slack から来ても同じ形で残る", () => {
    // Discord と Slack は共通の注入経路を通るので、platform だけが違う。
    const [message] = projectEvent(
      injectEvent({ ...PROVENANCE, platform: "slack", emoji: "🙏", actorId: "U123" }),
      CTX,
    );

    expect(message.author_platform).toBe("slack");
    expect(message.metadata).toMatchObject({
      injection: { platform: "slack", emoji: "🙏" },
    });
    expect(JSON.stringify(message.metadata)).not.toContain("U123");
  });

  it("任意項目が欠けても metadata が壊れない", () => {
    const minimal: InjectionProvenance = {
      kind: "reaction-workflow",
      action: "context-report",
      platform: "discord",
    };

    const [message] = projectEvent(injectEvent(minimal), CTX);
    expect(message.metadata).toEqual({
      injection: { kind: "reaction-workflow", action: "context-report", platform: "discord" },
    });
  });
});
