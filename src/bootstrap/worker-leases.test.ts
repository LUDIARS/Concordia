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
    compareAndSwap: (key: string, expected: string | null, value: string | null) => {
      if ((values.get(key) ?? null) !== expected) return false;
      if (value === null) values.delete(key);
      else values.set(key, value);
      return true;
    },
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

  it("uses CAS ownership and monotonically increasing fencing tokens", () => {
    const repo = makeRepo();
    let now = 1_000;
    const first = startChatWorkerLease(repo, { pid: 10, now: () => now });
    expect(() => startChatWorkerLease(repo, { pid: 20, now: () => now })).toThrow(/already owned/);
    now = 100_000;
    const second = startChatWorkerLease(repo, { pid: 20, now: () => now });
    expect(second.lease.fencing_token).toBe(first.lease.fencing_token + 1);
    first.stop();
    expect(readChatWorkerLease(repo, now)?.pid).toBe(20);
    second.stop();
  });
});
