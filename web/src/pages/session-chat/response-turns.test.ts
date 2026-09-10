import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../../api.js";
import { isResponseWorking, responseBlocks } from "./response-turns.js";

function message(id: number, author_type: SessionMessage["author_type"], phase?: string): SessionMessage {
  return { id, session_id: "s1", ts: id, edited_ts: null, author_type, author_label: author_type,
    author_platform: null, content: `message ${id}`, embeds: null, components: null, attachments: null,
    reference_id: null, metadata: phase ? { phase } : null, dedupe_key: null };
}

describe("response presentation", () => {
  it("folds completed work while preserving input, questions, attachments and the next response", () => {
    const messages = [message(1, "user"), message(2, "assistant", "commentary"), message(3, "question"),
      { ...message(4, "assistant"), attachments: [{ kind: "image" }] }, message(5, "tool"),
      message(6, "assistant", "final_answer"), message(7, "user"), message(8, "thinking")];
    const blocks = responseBlocks(messages);
    expect(blocks.filter((block) => block.folded).flatMap((block) => block.messages.map((item) => item.id))).toEqual([2, 5]);
    expect(blocks.flatMap((block) => block.messages)).toEqual(messages);
    expect(blocks.at(-1)?.folded).toBe(false);
  });

  it("treats Claude summary as the boundary, leaving legacy assistant text uncollapsed", () => {
    expect(responseBlocks([message(1, "assistant"), message(2, "summary")])[0].folded).toBe(true);
    expect(responseBlocks([message(1, "assistant")])[0].folded).toBe(false);
  });

  it("shows work only with activity evidence and stops for final, questions, permission and inactive sessions", () => {
    expect(isResponseWorking([], "active")).toBe(false);
    expect(isResponseWorking([], "active", 0)).toBe(true);
    expect(isResponseWorking([message(1, "user")], "active")).toBe(true);
    expect(isResponseWorking([message(2, "assistant", "commentary")], "active")).toBe(true);
    for (const item of [message(2, "summary"), message(2, "assistant", "final_answer"), message(2, "question"), message(2, "permission")]) {
      expect(isResponseWorking([item], "active", 1)).toBe(false);
    }
    for (const status of ["lost", "ended", "abandoned"] as const) {
      expect(isResponseWorking([message(1, "tool")], status, 0)).toBe(false);
    }
  });
});
