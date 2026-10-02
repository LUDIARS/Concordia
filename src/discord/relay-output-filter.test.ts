import { describe, expect, it } from "vitest";
import { shouldRelaySessionChatPost, shouldRelaySessionMessage } from "./relay-output-filter.js";

const all = { intermediate: true, injectTranscript: true };
const consult = { intermediate: false, injectTranscript: false };

describe("shouldRelaySessionMessage", () => {
  it("全部出す方針では従来どおり何も落とさない", () => {
    for (const author_type of ["assistant", "tool", "task", "system", "delegation", "summary"] as const) {
      expect(shouldRelaySessionMessage({ author_type }, all)).toBe(true);
    }
  });

  it("技術相談課の方針では最終回答と会話の要約だけを流す", () => {
    expect(shouldRelaySessionMessage({ author_type: "assistant", metadata: { phase: "final_answer" } }, consult)).toBe(true);
    expect(shouldRelaySessionMessage({ author_type: "summary" }, consult)).toBe(true);
    expect(shouldRelaySessionMessage({ author_type: "assistant", metadata: { phase: "commentary" } }, consult)).toBe(false);
    expect(shouldRelaySessionMessage({ author_type: "assistant" }, consult)).toBe(false);
    expect(shouldRelaySessionMessage({ author_type: "tool" }, consult)).toBe(false);
  });

  it("指令の転記だけを止める方針では task / delegation / system を落とし、 途中の発言は残す", () => {
    const policy = { intermediate: true, injectTranscript: false };
    expect(shouldRelaySessionMessage({ author_type: "task" }, policy)).toBe(false);
    expect(shouldRelaySessionMessage({ author_type: "delegation" }, policy)).toBe(false);
    expect(shouldRelaySessionMessage({ author_type: "system" }, policy)).toBe(false);
    expect(shouldRelaySessionMessage({ author_type: "assistant" }, policy)).toBe(true);
  });

  it("途中の発言を止めた方針では chat 経路の投稿 (独白・圧縮の通知など) を一切流さない", () => {
    expect(shouldRelaySessionChatPost(consult)).toBe(false);
    expect(shouldRelaySessionChatPost(all)).toBe(true);
  });
});
