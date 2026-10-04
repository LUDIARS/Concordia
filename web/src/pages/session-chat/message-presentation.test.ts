import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../../api.js";
import { isCcInjection, messageTone, visibleChatMessages } from "./message-presentation.js";
import { isResponseWorking, responseBlocks } from "./response-turns.js";

function message(id: number, author_type: SessionMessage["author_type"], content: string, metadata: SessionMessage["metadata"] = null): SessionMessage {
  return { id, session_id: "s1", ts: id, edited_ts: null, author_type, author_label: author_type,
    author_platform: null, content, metadata, embeds: null, components: null, attachments: null, reference_id: null, dedupe_key: null };
}

describe("workplace message presentation", () => {
  it("distinguishes Cc context from explicit human input and quoted markers", () => {
    expect(isCcInjection(message(1, "user", "[Cc policy update]\ncontext"))).toBe(true);
    expect(isCcInjection(message(2, "system", "context", { inject_is_cc: true }))).toBe(true);
    expect(isCcInjection(message(3, "user", "[Cc policy update]について説明して", { inject_is_cc: false }))).toBe(false);
    expect(isCcInjection(message(4, "user", "この文面を確認: [Cc policy update]"))).toBe(false);
    expect(isCcInjection(message(5, "assistant", "[Cc policy update]"))).toBe(false);
    expect(messageTone(message(6, "user", "回答"))).toBe("human");
    expect(messageTone(message(7, "summary", "完了"))).toBe("ai");
  });

  it("keeps final answers, human input, errors and decisions when intermediate output is off", () => {
    const messages = [message(1, "user", "依頼"), message(2, "assistant", "途中"), message(3, "thinking", "思考"),
      message(4, "tool", "成功"), message(5, "tool", "失敗", { is_error: true }), message(6, "question", "確認"),
      message(7, "permission", "許可"), message(8, "assistant", "回答", { phase: "final_answer" }),
      message(9, "summary", "要約"), message(10, "system", "警告"), message(11, "user", "[Cc policy update] context")];
    expect(visibleChatMessages(messages, { intermediate: false, inject_transcript: false }).map((item) => item.id))
      .toEqual([1, 5, 6, 7, 8, 9, 10]);
    expect(visibleChatMessages(messages, {})).toEqual(messages);
  });

  it("does not restart the working indicator or break the response boundary for injected context", () => {
    const progress = message(1, "assistant", "進行中");
    const injection = message(2, "user", "[Cc policy update] context");
    const final = message(3, "assistant", "完了", { phase: "final_answer" });
    expect(responseBlocks([progress, injection, final])[0].folded).toBe(true);
    expect(isResponseWorking([final, { ...injection, id: 4 }], "active")).toBe(false);
    expect(isResponseWorking([message(1, "user", "依頼")], "active")).toBe(true);
  });

  it("hides only provenance-linked transcript echoes and preserves separate identical player posts", () => {
    const first = message(1, "user", "続けて");
    const second = message(2, "user", "続けて");
    const echo = message(3, "user", "続けて", { echo_of_message_id: 1, echo_identity_verified: true });
    expect(visibleChatMessages([first, second, echo], {}).map((item) => item.id)).toEqual([1, 2]);
    const final = message(4, "summary", "完了");
    expect(isResponseWorking([first, final, { ...echo, id: 5 }], "active")).toBe(false);
    expect(visibleChatMessages([message(6, "user", "同文", { echo_of_message_id: "1" })], {})).toHaveLength(1);
    expect(visibleChatMessages([message(7, "user", "同文", { echo_of_message_id: 1 })], {})).toHaveLength(1);
  });
});
