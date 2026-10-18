import { describe, expect, it } from "vitest";
import { leftTalks, routeLineEvents, type LineEvent, type TalkLink } from "./routing.js";
import { isLinkCommand, matchServiceKeyword, routingText } from "./routing-text.js";
import type { LineWebhookTarget } from "./targets.js";

/** テスト値 (実物ではない)。 */
const GROUP = "C0000000000000000000000000000000a";
const OTHER_GROUP = "C0000000000000000000000000000000b";
const USER = "U0000000000000000000000000000000c";

function service(name: string, keywords: string[] = [], overrides: Partial<LineWebhookTarget> = {}): LineWebhookTarget {
  return { name, url: `http://192.0.2.10/${name}`, host: null, enabled: true, channel: "ludiars", keywords, ...overrides };
}

const mf = service("mf", ["おてつだい", "MF"]);
const mm = service("mm", ["メモリア", "MFX"]);
const services = [mf, mm];

const text = (body: string, talk = GROUP, extra: Record<string, unknown> = {}): LineEvent => ({
  type: "message",
  replyToken: "reply-token-1",
  source: { type: "group", groupId: talk, userId: USER },
  message: { type: "text", id: "1", text: body, ...extra },
});

const linksOf = (table: Record<string, TalkLink[]>) => (talkId: string) => table[talkId] ?? [];
const noLinks = linksOf({});
const mfDefault = linksOf({ [GROUP]: [{ service: "mf", isDefault: true }, { service: "mm", isDefault: false }] });

function summary(events: LineEvent[], links = noLinks) {
  return routeLineEvents(events, services, links).map((delivery) => ({
    service: delivery.service.name,
    talk: delivery.talk.id,
    events: delivery.events.length,
    link: delivery.linkRequested,
  }));
}

describe("routingText", () => {
  it("ボットへのメンション部分と先頭の空白を除く (ほかの人へのメンションは残す)", () => {
    const body = "@ボット　おてつだい @たろう";
    expect(routingText({
      type: "text",
      text: body,
      mention: { mentionees: [
        { index: 0, length: 4, type: "user", isSelf: true },
        { index: 11, length: 4, type: "user", isSelf: false },
      ] },
    })).toBe("おてつだい @たろう");
  });

  it("メンションが無ければ先頭の空白だけを除く", () => {
    expect(routingText({ type: "text", text: " 　メモリア きょう" })).toBe("メモリア きょう");
  });
});

describe("matchServiceKeyword", () => {
  it("長い言葉を優先する", () => {
    expect(matchServiceKeyword("MFX のこと", services)).toBe(mm);
    expect(matchServiceKeyword("MF のこと", services)).toBe(mf);
  });

  it("同じ長さなら設定順で先のサービス", () => {
    const a = service("a", ["よぶ"]);
    const b = service("b", ["よぶ"]);
    expect(matchServiceKeyword("よぶよ", [a, b])).toBe(a);
  });

  it("どの言葉でも始まらなければ null", () => {
    expect(matchServiceKeyword("きょうはおてつだい", services)).toBeNull();
    expect(matchServiceKeyword("", services)).toBeNull();
  });
});

describe("isLinkCommand", () => {
  it.each(["つなぐ 1234", "つなぐ１２３４", "つなぐ　1 2 3", "つなぐ 1234 "])("「%s」 はつなぐ", (body) => {
    expect(isLinkCommand(body)).toBe(true);
  });

  it.each(["つなぐ", "つなぐ abc", "つなぐ 12a", "つないで 12", "あとで つなぐ 12"])("「%s」 はつなぐではない", (body) => {
    expect(isLinkCommand(body)).toBe(false);
  });
});

describe("routeLineEvents — text", () => {
  it("呼びかけの言葉で始まる発言はそのサービスだけへ (メンションを除いて判定)", () => {
    const event = text("@ボット メモリア きょうのこと", GROUP, {
      mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
    });
    expect(summary([event], mfDefault)).toEqual([{ service: "mm", talk: GROUP, events: 1, link: false }]);
  });

  it("言葉の無い発言はそのトークのふだんの相手だけへ", () => {
    expect(summary([text("ただいま")], mfDefault)).toEqual([{ service: "mf", talk: GROUP, events: 1, link: false }]);
  });

  it("ふだんの相手が無いトークの、言葉の無い発言は誰にも回さない", () => {
    expect(summary([text("ただいま")])).toEqual([]);
    expect(summary([text("ただいま", OTHER_GROUP)], mfDefault)).toEqual([]);
  });

  it("「つなぐ <コード>」 は全サービスへ回し、つなぐ要求として印を付ける", () => {
    expect(summary([text("つなぐ １２３４")])).toEqual([
      { service: "mf", talk: GROUP, events: 1, link: true },
      { service: "mm", talk: GROUP, events: 1, link: true },
    ]);
  });

  it("トークごとに回し先を分け、同じサービス・トークのイベントは 1 本にまとめる", () => {
    const deliveries = routeLineEvents(
      [text("おてつだい 1"), text("メモリア"), text("おてつだい 2"), text("おてつだい", OTHER_GROUP)],
      services, noLinks,
    );
    expect(deliveries.map((delivery) => [delivery.service.name, delivery.talk.id, delivery.events.length])).toEqual([
      ["mf", GROUP, 2], ["mf", OTHER_GROUP, 1], ["mm", GROUP, 1],
    ]);
  });

  it("text 以外のメッセージはふだんの相手へ", () => {
    const image: LineEvent = { type: "message", source: { type: "group", groupId: GROUP }, message: { type: "image", id: "2" } };
    expect(summary([image], mfDefault)).toEqual([{ service: "mf", talk: GROUP, events: 1, link: false }]);
    expect(summary([image])).toEqual([]);
  });

  it("source の無いイベントは回さない", () => {
    expect(summary([{ type: "message", message: { type: "text", text: "おてつだい" } }])).toEqual([]);
  });

  it("1 対 1 のトークは userId で、トークルームは roomId で分ける", () => {
    const direct: LineEvent = { type: "message", source: { type: "user", userId: USER }, message: { type: "text", text: "おてつだい" } };
    const room: LineEvent = { type: "message", source: { type: "room", roomId: "R0", userId: USER }, message: { type: "text", text: "メモリア" } };
    expect(summary([direct, room])).toEqual([
      { service: "mf", talk: USER, events: 1, link: false },
      { service: "mm", talk: "R0", events: 1, link: false },
    ]);
  });
});

describe("routeLineEvents — postback", () => {
  const postback = (data: string): LineEvent => ({
    type: "postback", replyToken: "reply-token-2", source: { type: "group", groupId: GROUP }, postback: { data },
  });

  it("包みを外して、包みのサービスへ元の data で回す", () => {
    const [delivery, ...rest] = routeLineEvents([postback("cc:mm:action=done&id=1")], services, noLinks);
    expect(rest).toEqual([]);
    expect(delivery!.service).toBe(mm);
    expect(delivery!.events[0]!.postback).toEqual({ data: "action=done&id=1" });
  });

  it("包みの無い postback・そのチャネルに無いサービスの包みは回さない", () => {
    expect(summary([postback("action=done")], mfDefault)).toEqual([]);
    expect(summary([postback("cc:other:action=done")], mfDefault)).toEqual([]);
  });
});

describe("routeLineEvents — 参加・退出", () => {
  const event = (type: string, talk = GROUP): LineEvent => ({ type, source: { type: "group", groupId: talk } });

  it("leave / memberLeft / memberJoined はつながっている全サービスへ", () => {
    for (const type of ["leave", "memberLeft", "memberJoined"]) {
      expect(summary([event(type)], mfDefault).map((item) => item.service)).toEqual(["mf", "mm"]);
      expect(summary([event(type)])).toEqual([]);
    }
  });

  it("follow / join は全サービスへ", () => {
    expect(summary([event("join")]).map((item) => item.service)).toEqual(["mf", "mm"]);
    expect(summary([{ type: "follow", source: { type: "user", userId: USER } }]).map((item) => item.service)).toEqual(["mf", "mm"]);
  });

  it("leftTalks はボットが抜けたトークだけを返す", () => {
    expect(leftTalks([event("leave"), event("memberLeft", OTHER_GROUP), event("leave")])).toEqual([{ id: GROUP, kind: "group" }]);
  });
});

describe("routeLineEvents — サービスの範囲", () => {
  it("渡されたサービス (そのチャネルの enabled) の外へは回さない", () => {
    const deliveries = routeLineEvents([text("つなぐ 1")], [mf], noLinks);
    expect(deliveries.map((delivery) => delivery.service.name)).toEqual(["mf"]);
  });
});
