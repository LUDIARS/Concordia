import { describe, expect, it } from "vitest";
import { mergeReplies, mergeRepliesWithDrops } from "./merge-replies.js";
import { MAX_POSTBACK_DATA_LENGTH, unwrapPostbackData, wrapReplyPostbacks } from "./postback.js";
import type { LineReply } from "./replies.js";

const message = (text: string) => ({ type: "text", text });

describe("wrapReplyPostbacks", () => {
  it("テンプレート・クイックリプライの postback / datetimepicker の data を cc:<サービス>: で包む", () => {
    const reply: LineReply = {
      replyToken: "reply-token-1",
      messages: [{
        type: "template",
        altText: "えらぶ",
        template: { type: "buttons", text: "どれ", actions: [
          { type: "postback", label: "できた", data: "action=done" },
          { type: "uri", label: "ひらく", uri: "https://example.test/" },
        ] },
        quickReply: { items: [{ type: "action", action: { type: "datetimepicker", data: "pick=1", mode: "date" } }] },
      }],
    };
    const wrapped = wrapReplyPostbacks(reply, "mf");
    const template = wrapped.messages[0]!.template as { actions: Array<Record<string, unknown>> };
    expect(template.actions[0]!.data).toBe("cc:mf:action=done");
    expect(template.actions[1]).toEqual({ type: "uri", label: "ひらく", uri: "https://example.test/" });
    const quick = wrapped.messages[0]!.quickReply as { items: Array<{ action: Record<string, unknown> }> };
    expect(quick.items[0]!.action.data).toBe("cc:mf:pick=1");
    // 元の返信は書き換えない。
    expect((reply.messages[0]!.template as { actions: Array<Record<string, unknown>> }).actions[0]!.data).toBe("action=done");
  });

  it("包むと 300 文字を超える data があれば、その返信は元のまま (同じオブジェクト) を返す", () => {
    const limit = MAX_POSTBACK_DATA_LENGTH - "cc:mf:".length;
    const fits: LineReply = { replyToken: "r", messages: [{ type: "postback", data: "x".repeat(limit) }] };
    expect(wrapReplyPostbacks(fits, "mf").messages[0]!.data).toHaveLength(MAX_POSTBACK_DATA_LENGTH);
    const over: LineReply = {
      replyToken: "r",
      messages: [{ type: "postback", data: "short" }, { type: "postback", data: "x".repeat(limit + 1) }],
    };
    expect(wrapReplyPostbacks(over, "mf")).toBe(over);
  });

  it("postback の無い返信は中身を変えない", () => {
    const reply: LineReply = { replyToken: "r", messages: [message("おかえり")] };
    expect(wrapReplyPostbacks(reply, "mf")).toEqual(reply);
  });
});

describe("unwrapPostbackData", () => {
  it("cc:<サービス>:<元の data> を外す (元の data に : があってもよい)", () => {
    expect(unwrapPostbackData("cc:mf:action=done")).toEqual({ service: "mf", data: "action=done" });
    expect(unwrapPostbackData("cc:mm:a:b:c")).toEqual({ service: "mm", data: "a:b:c" });
    expect(unwrapPostbackData("cc:mf:")).toEqual({ service: "mf", data: "" });
  });

  it("包みが無ければ null", () => {
    expect(unwrapPostbackData("action=done")).toBeNull();
    expect(unwrapPostbackData("cc:MF:x")).toBeNull();
    expect(unwrapPostbackData(undefined)).toBeNull();
  });
});

describe("mergeReplies", () => {
  it("同じ replyToken の返信を設定順に連結し、別の replyToken は別のまま", () => {
    expect(mergeReplies([
      [{ replyToken: "join-1", messages: [message("mf です")] }],
      [{ replyToken: "join-1", messages: [message("mm です")] }, { replyToken: "other", messages: [message("べつ")] }],
    ])).toEqual([
      { replyToken: "join-1", messages: [message("mf です"), message("mm です")] },
      { replyToken: "other", messages: [message("べつ")] },
    ]);
  });

  it("5 件を超えた分は捨て、捨てた件数を返す", () => {
    const four = Array.from({ length: 4 }, (_, index) => message(`mf-${index}`));
    const three = Array.from({ length: 3 }, (_, index) => message(`mm-${index}`));
    const merged = mergeRepliesWithDrops([[{ replyToken: "join-1", messages: four }], [{ replyToken: "join-1", messages: three }]]);
    expect(merged.replies).toEqual([{ replyToken: "join-1", messages: [...four, message("mm-0")] }]);
    expect(merged.dropped).toBe(2);
  });
});
