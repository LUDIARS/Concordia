import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { reconcileConversationHandoffs, startConversationReconciler } from "./reconciler.js";
import { ConversationRepo } from "./repo.js";

let repo: ConversationRepo;

function seedHandoff(id: string, state: "handoff_pending" | "handoff_saved" | "aborted"): void {
  const conversation = repo.ensureConversation({ platform: "discord", scope: "", guildId: "1", threadId: id, ownerSessionId: "s1", now: 1 });
  repo.createHandoff({
    id, conversationId: conversation.conversation_id, fromSessionId: "s1", fromGeneration: 1,
    triggerInputId: null, nextInstruction: "", correlationId: `handoff:${id}`, now: 1,
  });
  if (state === "handoff_saved") repo.transitionHandoff(id, "handoff_pending", "handoff_saved", { package_json: "{}" }, 2);
  if (state === "aborted") repo.transitionHandoff(id, "handoff_pending", "aborted", {}, 2);
}

beforeEach(() => {
  repo = new ConversationRepo(makeTestDb());
});

describe("reconcileConversationHandoffs", () => {
  it("advances every open handoff and skips terminal ones", async () => {
    seedHandoff("a", "handoff_pending");
    seedHandoff("b", "handoff_saved");
    seedHandoff("c", "aborted");
    const advance = vi.fn(async (id: string) => {
      if (id === "b") return repo.transitionHandoff("b", "handoff_saved", "successor_requested", {}, 3);
      return repo.findHandoff(id);
    });
    const advanced = await reconcileConversationHandoffs({ repo, service: { advance } });
    expect(advance.mock.calls.map((call) => call[0]).sort()).toEqual(["a", "b"]);
    expect(advanced).toBe(1);
  });

  it("isolates a failing handoff from the others", async () => {
    seedHandoff("a", "handoff_pending");
    seedHandoff("b", "handoff_pending");
    const onError = vi.fn();
    const advance = vi.fn(async (id: string) => {
      if (id === "a") throw new Error("boom");
      return repo.findHandoff(id);
    });
    await reconcileConversationHandoffs({ repo, service: { advance }, onError });
    expect(onError).toHaveBeenCalledWith("a", expect.any(Error));
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it("runs once on start and stops cleanly", async () => {
    seedHandoff("a", "handoff_pending");
    const advance = vi.fn(async (id: string) => repo.findHandoff(id));
    const handle = startConversationReconciler({ repo, service: { advance }, intervalMs: 60_000 });
    await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    handle.stop();
  });
});
