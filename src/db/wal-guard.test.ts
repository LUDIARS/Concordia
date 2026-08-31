import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { assessWalHealth, runWalGuardOnce } from "./wal-guard.js";

describe("assessWalHealth", () => {
  it("is healthy when the checkpoint drained the log and the file is small", () => {
    const health = assessWalHealth({ busy: 0, log: 757, checkpointed: 757 }, 3_000_000, 64 * 1024 * 1024);
    expect(health).toEqual({ starved: false, oversized: false, pendingFrames: 0 });
  });

  it("flags starvation when frames remain or the checkpoint hit a busy reader", () => {
    expect(assessWalHealth({ busy: 0, log: 9000, checkpointed: 120 }, 1, 64).starved).toBe(true);
    expect(assessWalHealth({ busy: 1, log: 10, checkpointed: 10 }, 1, 64).starved).toBe(true);
  });

  it("flags an oversized WAL file", () => {
    const health = assessWalHealth({ busy: 0, log: 0, checkpointed: 0 }, 375_513_312, 64 * 1024 * 1024);
    expect(health.oversized).toBe(true);
    expect(health.starved).toBe(false);
  });
});

describe("runWalGuardOnce", () => {
  it("runs a passive checkpoint and logs a warning when starved", () => {
    const db = {
      pragma: vi.fn(() => [{ busy: 0, log: 5000, checkpointed: 100 }]),
    };
    const warn = vi.fn();
    const info = vi.fn();
    const health = runWalGuardOnce({ db, dbPath: "x.db", walBytes: () => 10, limitBytes: 64, log: { info, warn } });
    expect(db.pragma).toHaveBeenCalledWith("wal_checkpoint(PASSIVE)");
    expect(health.starved).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("works against a real WAL database", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    const health = runWalGuardOnce({ db, dbPath: ":memory:", walBytes: () => 0, log: { info: vi.fn(), warn: vi.fn() } });
    expect(health.oversized).toBe(false);
    db.close();
  });
});
