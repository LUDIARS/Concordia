import { describe, expect, it } from "vitest";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { readChatWorkerLease, startChatWorkerLease } from "./chat.js";
import { readWorkflowWorkerLease, startWorkflowWorkerLease } from "./workflow.js";

function makeRepo(): DiscordConfigRepo {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  } as unknown as DiscordConfigRepo;
}

describe("chat/workflow worker leases", () => {
  it("keeps chat and workflow ownership in independent lease keys", () => {
    const repo = makeRepo();
    const chat = startChatWorkerLease(repo, { pid: 10, now: () => 1_000 });
    const workflow = startWorkflowWorkerLease(repo, { pid: 20, now: () => 1_000 });
    expect(readChatWorkerLease(repo, 1_001)?.pid).toBe(10);
    expect(readWorkflowWorkerLease(repo, 1_001)?.pid).toBe(20);

    chat.stop();
    expect(readChatWorkerLease(repo, 1_001)).toBeNull();
    expect(readWorkflowWorkerLease(repo, 1_001)?.pid).toBe(20);
    workflow.stop();
  });
});
