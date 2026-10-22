import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSessionMessageDeliveryRepo } from "../db/session-message-delivery-repo.js";
import type { SessionMessagePayload } from "../shared/session-message-types.js";
import {
  relaySessionMessageToSlack,
  shouldRelaySlackSessionChat,
  type SlackSessionMessageDeps,
} from "./session-message-egress.js";

function message(overrides: Partial<SessionMessagePayload>): SessionMessagePayload {
  return {
    id: 7, session_id: "s1", ts: 1, edited_ts: null, author_type: "assistant", author_label: "AI",
    author_platform: null, content: "最終回答", embeds: null, components: null, attachments: null,
    reference_id: null, metadata: { phase: "final_answer" }, dedupe_key: null, ...overrides,
  };
}

function deps(overrides: Partial<SlackSessionMessageDeps> = {}) {
  const postMessage = vi.fn(async () => ({ ts: "100.1" }));
  const update = vi.fn(async () => ({}));
  const value: SlackSessionMessageDeps = {
    client: { chat: { postMessage, update } },
    deliveries: makeSessionMessageDeliveryRepo(makeTestDb()),
    isSessionActive: () => true,
    ensureChannel: async () => "C1",
    authorName: () => "Opus",
    log: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
  return { value, postMessage, update };
}

const event = (m: SessionMessagePayload, op: "create" | "update" = "create") =>
  ({ type: "session.message" as const, target_session_id: "s1", op, message: m, ts: 5 });

describe("relaySessionMessageToSlack", () => {
  it("posts a relayable message once and edits it on update", async () => {
    const { value, postMessage, update } = deps();
    await expect(relaySessionMessageToSlack(value, event(message({})))).resolves.toMatchObject({ posted: true, ts: "100.1" });
    expect(postMessage).toHaveBeenCalledWith({ channel: "C1", text: "最終回答", username: "Opus" });

    await relaySessionMessageToSlack(value, event(message({})));
    expect(postMessage).toHaveBeenCalledTimes(1);

    await relaySessionMessageToSlack(value, event(message({ content: "直した回答" }), "update"));
    expect(update).toHaveBeenCalledWith({ channel: "C1", ts: "100.1", text: "直した回答" });
  });

  it("drops what Discord drops: intermediate output when the department turns it off, turn status, Discord ingress", async () => {
    const finalOnly = { intermediate: false, injectTranscript: false };
    const { value, postMessage } = deps({ relayOutputPolicy: () => finalOnly });
    await relaySessionMessageToSlack(value, event(message({ metadata: { phase: "commentary" } })));
    await relaySessionMessageToSlack(value, event(message({ metadata: { response_turn: true } })));
    await relaySessionMessageToSlack(value, event(message({ author_type: "user", author_platform: "discord" })));
    expect(postMessage).not.toHaveBeenCalled();

    await relaySessionMessageToSlack(value, event(message({})));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not post for an inactive session", async () => {
    const { value, postMessage } = deps({ isSessionActive: () => false });
    await expect(relaySessionMessageToSlack(value, event(message({})))).resolves.toEqual({ posted: false });
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("shouldRelaySlackSessionChat", () => {
  it("passes every chat when intermediate output is on, only own artifacts when it is off", () => {
    expect(shouldRelaySlackSessionChat({ intermediate: true, injectTranscript: true }, { channel: "system", attachmentCount: 0 })).toBe(true);
    const off = { intermediate: false, injectTranscript: false };
    expect(shouldRelaySlackSessionChat(off, { channel: "system", attachmentCount: 0 })).toBe(false);
    expect(shouldRelaySlackSessionChat(off, { channel: "報告", attachmentCount: 2 })).toBe(false);
    expect(shouldRelaySlackSessionChat(off, { channel: "system", attachmentCount: 3 })).toBe(true);
  });
});
