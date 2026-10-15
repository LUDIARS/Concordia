import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { handlePackageUpdates, neutralizePackageUpdateText, type PackageUpdateEvent, type PackageUpdateLedger } from "./package-updates.js";
import { SqlitePackageUpdateLedger } from "./package-updates-runtime.js";

const event: PackageUpdateEvent = {
  source: "ergo-watch",
  runId: "run-1",
  messages: [{ text: "pkg-a 1.2.0", private: false }, { text: "pkg-b 0.3.1", private: true }],
};

function memoryLedger(): PackageUpdateLedger & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    claim: (runId, index) => { const key = `${runId}:${index}`; if (keys.has(key)) return false; keys.add(key); return true; },
    release: (runId, index) => { keys.delete(`${runId}:${index}`); },
  };
}

function sqliteLedger(): SqlitePackageUpdateLedger {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE package_update_ledger (run_id TEXT NOT NULL, message_index INTEGER NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (run_id, message_index))");
  return new SqlitePackageUpdateLedger(db);
}

describe("package update notices", () => {
  it("posts each message in order and reports the count", async () => {
    const post = vi.fn(async () => {});
    await expect(handlePackageUpdates({ event, ledger: memoryLedger(), post }))
      .resolves.toEqual({ delivered: 2, failed: [], duplicate: false });
    expect(post.mock.calls.map((call) => call[0])).toEqual(["pkg-a 1.2.0", "pkg-b 0.3.1"]);
  });

  it("does not post the same (runId, index) twice", async () => {
    const ledger = sqliteLedger();
    const post = vi.fn(async () => {});
    await handlePackageUpdates({ event, ledger, post });
    await expect(handlePackageUpdates({ event, ledger, post }))
      .resolves.toEqual({ delivered: 0, failed: [], duplicate: true });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("delivers only the new indices of a known run", async () => {
    const ledger = memoryLedger();
    ledger.claim("run-1", 0);
    const post = vi.fn(async () => {});
    await expect(handlePackageUpdates({ event, ledger, post }))
      .resolves.toEqual({ delivered: 1, failed: [], duplicate: false });
    expect(post).toHaveBeenCalledWith("pkg-b 0.3.1");
  });

  it("does not count a failed post as delivered and allows it to be retried", async () => {
    const ledger = sqliteLedger();
    const post = vi.fn(async (content: string) => { if (content.startsWith("pkg-b")) throw new Error("rejected (500)"); });
    await expect(handlePackageUpdates({ event, ledger, post }))
      .resolves.toEqual({ delivered: 1, failed: [{ index: 1, error: "rejected (500)" }], duplicate: false });
    post.mockImplementation(async () => {});
    await expect(handlePackageUpdates({ event, ledger, post }))
      .resolves.toEqual({ delivered: 1, failed: [], duplicate: false });
  });

  it("neutralizes mentions before posting", async () => {
    const post = vi.fn(async () => {});
    const hostile: PackageUpdateEvent = { ...event, messages: [{ text: "@everyone @here <@123> <@&456> <#789> <:x:1> ok", private: false }] };
    await handlePackageUpdates({ event: hostile, ledger: memoryLedger(), post });
    const posted = post.mock.calls[0]?.[0] as string;
    expect(posted).not.toMatch(/@everyone|@here|<@|<#|<:/);
    expect(posted.replace(/​/g, "")).toBe("@everyone @here <@123> <@&456> <#789> <:x:1> ok");
    expect(neutralizePackageUpdateText("user@example.com")).toBe("user@example.com");
  });
});
