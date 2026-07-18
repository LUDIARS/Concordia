import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SlackSessionArchiveLifecycle } from "./session-channel-archive.js";
import { makeSlackSessionChannelsRepo } from "./session-channels-repo.js";

describe("SlackSessionArchiveLifecycle", () => {
  it("archives due channels and retries failures without marking them archived", async () => {
    let now = 100;
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => now);
    repo.upsert({ session_id: "ok", channel_id: "C1", channel_name: "ok" });
    repo.upsert({ session_id: "retry", channel_id: "C2", channel_name: "retry" });
    repo.scheduleArchive("ok", 100);
    repo.scheduleArchive("retry", 100);
    const archive = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ ok: true });
    const lifecycle = new SlackSessionArchiveLifecycle({
      repo,
      client: { conversations: { archive } },
      delaySeconds: 30,
      now: () => now,
    });

    await lifecycle.sweep();
    expect(repo.findBySessionId("ok")?.archived_at).toBe(100);
    expect(repo.findBySessionId("retry")?.archived_at).toBeNull();
    now = 101;
    await lifecycle.sweep();
    expect(repo.findBySessionId("retry")?.archived_at).toBe(101);
  });

  it("cancel() withdraws a pending archive so a resumed session is not archived on the next sweep", async () => {
    // セッション再開シナリオ: session.ended → schedule() で archive 予約が立つが、
    // archived_at が付く前に session.started (再開) が来たら cancel() で取り消す。
    // 取り消さなければ、 次の sweep で「今もアクティブな」 チャンネルが archive される
    // (継続レビュー指摘: slack/bot.ts:457)。
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => 100);
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "one" });
    repo.scheduleArchive("s1", 100);
    const archive = vi.fn(async () => ({ ok: true }));
    const lifecycle = new SlackSessionArchiveLifecycle({
      repo,
      client: { conversations: { archive } },
      delaySeconds: 30,
      now: () => 100,
    });

    lifecycle.cancel("s1");
    await lifecycle.sweep();

    expect(archive).not.toHaveBeenCalled();
    expect(repo.findBySessionId("s1")).toMatchObject({ archive_due_at: null, archived_at: null });
  });

  it("sweeps overdue rows on start and releases its single timer on stop", async () => {
    const repo = makeSlackSessionChannelsRepo(makeTestDb(), () => 100);
    repo.upsert({ session_id: "s1", channel_id: "C1", channel_name: "one" });
    repo.scheduleArchive("s1", 99);
    const archive = vi.fn(async () => ({ ok: true }));
    const setIntervalFn = vi.fn((_handler: () => void, _ms: number) => ({ unref: vi.fn() }) as never);
    const clearIntervalFn = vi.fn();
    const lifecycle = new SlackSessionArchiveLifecycle({
      repo,
      client: { conversations: { archive } },
      delaySeconds: 30,
      now: () => 100,
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: clearIntervalFn as never,
    });

    await lifecycle.start();
    await lifecycle.start();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
