/**
 * lost / ended 照合の状態ずれ判定 (spec/plan/2026-11-21-cc-full-scan-elimination.md FS-16)。
 * 行ごとに sessions を読んでいた旧判定と、 照合の頭で 1 回だけ JOIN する新判定が同じ行を選ぶこと、
 * 行数が増えても SQL の回数が増えないことを、 実 DB (in-memory) で確かめる。
 */
import { ChannelType } from "discord.js";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordSessionChannelsRepo, type DiscordSessionStatus } from "../db/discord-repo.js";
import { reconcileEndedSessionChannels, reconcileLostSessionChannels } from "./session-channel.js";

function insertSession(db: Database.Database, id: string, status: string): void {
  db.prepare(`INSERT INTO sessions(id, provider, repo_path, host, started_at, status, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "codex", "repo", "host", 1, status, 1);
}

function bind(db: Database.Database, scope: string, sessionId: string, status: DiscordSessionStatus): void {
  makeDiscordSessionChannelsRepo(db, scope).upsert({
    session_id: sessionId, channel_id: `chan-${sessionId}`, status, display_state: status,
  });
}

/** 旧判定: 行ごとに sessions を読み、 sessions 行が無ければ偽 (readSessionRelay(...)?.status === X と同じ)。 */
function oldSelects(db: Database.Database, scope: string, status: "lost" | "ended"): string[] {
  const repo = makeDiscordSessionChannelsRepo(db, scope);
  return repo.listAll()
    .filter((row) => {
      const session = db.prepare("SELECT status FROM sessions WHERE id = ?").get(row.session_id) as { status: string } | undefined;
      return row.status === status || session?.status === status;
    })
    .map((row) => row.session_id)
    .sort();
}

function newSelects(db: Database.Database, scope: string, status: "lost" | "ended"): string[] {
  const repo = makeDiscordSessionChannelsRepo(db, scope);
  const drift = new Set(repo.listSessionStatusDrift(status));
  return repo.listAll()
    .filter((row) => row.status === status || drift.has(row.session_id))
    .map((row) => row.session_id)
    .sort();
}

/** 代表的な行を本社 scope ('') と子会社 scope に並べる。 */
function seedRepresentativeRows(db: Database.Database): void {
  // 束縛 active / sessions ended → ended のずれ
  insertSession(db, "active-to-ended", "ended");
  bind(db, "", "active-to-ended", "active");
  // 束縛 active / sessions lost → lost のずれ
  insertSession(db, "active-to-lost", "lost");
  bind(db, "", "active-to-lost", "active");
  // 束縛 lost / sessions ended → ended のずれ
  insertSession(db, "lost-to-ended", "ended");
  bind(db, "", "lost-to-ended", "lost");
  // 束縛 ended / sessions ended (DB だけ閉じた行。 archive の修復対象)
  insertSession(db, "ended-both", "ended");
  bind(db, "", "ended-both", "ended");
  // 束縛 lost / sessions active (復帰前)
  insertSession(db, "lost-but-active", "active");
  bind(db, "", "lost-but-active", "lost");
  // 両方 active
  insertSession(db, "active-both", "active");
  bind(db, "", "active-both", "active");
  // sessions 行が無い active / ended / lost 束縛
  bind(db, "", "missing-active", "active");
  bind(db, "", "missing-ended", "ended");
  bind(db, "", "missing-lost", "lost");
  // 別 scope の ended ずれ (本社の照合には出ない)
  insertSession(db, "sub-active-to-ended", "ended");
  bind(db, "sub:child", "sub-active-to-ended", "active");
}

describe("listSessionStatusDrift", () => {
  it("selects exactly the rows the old per-row status check selected", () => {
    const db = makeTestDb();
    seedRepresentativeRows(db);
    for (const scope of ["", "sub:child"]) {
      for (const status of ["lost", "ended"] as const) {
        expect(newSelects(db, scope, status)).toEqual(oldSelects(db, scope, status));
      }
    }
  });

  it("returns only rows whose binding lags behind the session, within its scope", () => {
    const db = makeTestDb();
    seedRepresentativeRows(db);
    const hq = makeDiscordSessionChannelsRepo(db, "");
    expect(hq.listSessionStatusDrift("ended").sort()).toEqual(["active-to-ended", "lost-to-ended"]);
    expect(hq.listSessionStatusDrift("lost")).toEqual(["active-to-lost"]);
    expect(makeDiscordSessionChannelsRepo(db, "sub:child").listSessionStatusDrift("ended")).toEqual(["sub-active-to-ended"]);
  });
});

function makeGuild(cached: Record<string, { parentId: string; name: string }>) {
  const cache = new Map<string, any>();
  for (const [id, init] of Object.entries(cached)) {
    const channel: any = {
      id, type: ChannelType.GuildText, ...init,
      edit: vi.fn(async (patch: { name?: string; parent?: string }) => {
        if (patch.name) channel.name = patch.name;
        if (patch.parent) channel.parentId = patch.parent;
        return channel;
      }),
    };
    cache.set(id, channel);
  }
  return {
    cache,
    guild: {
      channels: {
        cache,
        fetch: vi.fn(async (id?: string) => (id ? cache.get(id) ?? null : cache)),
        fetchActiveThreads: vi.fn(async () => { throw new Error("threads unavailable"); }),
      },
    },
  };
}

const layout = { archiveCategoryId: "archive-cat", sessionsCategoryId: "sessions-cat" } as never;
const log = { info: vi.fn(), warn: vi.fn() };

describe("reconcileEndedSessionChannels with the drift set", () => {
  it("archives drifted rows and still repairs ended rows whose archive was left to the reconcile", async () => {
    const db = makeTestDb();
    insertSession(db, "drifted", "ended");
    bind(db, "", "drifted", "active");
    insertSession(db, "db-closed", "ended");
    bind(db, "", "db-closed", "ended");
    bind(db, "", "missing-ended", "ended");
    bind(db, "", "missing-active", "active");
    insertSession(db, "live", "active");
    bind(db, "", "live", "active");
    const { guild, cache } = makeGuild({
      "chan-drifted": { parentId: "sessions-cat", name: "old" },
      "chan-db-closed": { parentId: "sessions-cat", name: "old" },
      "chan-live": { parentId: "sessions-cat", name: "live" },
    });
    const repo = makeDiscordSessionChannelsRepo(db, "");

    const result = await reconcileEndedSessionChannels({ guild: guild as never, layout, repo, log });

    expect(result).toEqual({ scanned: 5, drifted: 1, reconciled: 2 });
    expect(repo.findBySessionId("drifted")?.status).toBe("ended");
    expect(cache.get("chan-drifted").parentId).toBe("archive-cat");
    expect(cache.get("chan-db-closed").parentId).toBe("archive-cat");
    expect(cache.get("chan-live").parentId).toBe("sessions-cat");
    // sessions 行の無い active 束縛は orphan 照合の担当 (ここでは触らない)。
    expect(repo.findBySessionId("missing-active")?.status).toBe("active");
  });

  it("does not issue more SQL as the number of ended rows grows", async () => {
    const countPrepares = async (rows: number): Promise<number> => {
      const db = makeTestDb();
      for (let i = 0; i < rows; i++) {
        insertSession(db, `ended-${i}`, "ended");
        bind(db, "", `ended-${i}`, "ended");
        insertSession(db, `live-${i}`, "active");
        bind(db, "", `live-${i}`, "active");
      }
      const repo = makeDiscordSessionChannelsRepo(db, "");
      const { guild } = makeGuild({});
      const prepare = vi.spyOn(db, "prepare");
      const result = await reconcileEndedSessionChannels({ guild: guild as never, layout, repo, log });
      expect(result.reconciled).toBe(0);
      return prepare.mock.calls.length;
    };
    const small = await countPrepares(3);
    const large = await countPrepares(60);
    expect(large).toBe(small);
    // listAll と状態ずれの JOIN の 2 本だけ。
    expect(small).toBe(2);
  });
});

describe("reconcileLostSessionChannels with the drift set", () => {
  it("archives an active row whose session is lost and keeps the call count flat", async () => {
    const db = makeTestDb();
    insertSession(db, "gone", "lost");
    bind(db, "", "gone", "active");
    for (let i = 0; i < 20; i++) {
      insertSession(db, `old-${i}`, "ended");
      bind(db, "", `old-${i}`, "ended");
    }
    const { guild, cache } = makeGuild({ "chan-gone": { parentId: "sessions-cat", name: "old" } });
    const repo = makeDiscordSessionChannelsRepo(db, "");
    const prepare = vi.spyOn(db, "prepare");

    const result = await reconcileLostSessionChannels({ guild: guild as never, layout, repo, log });

    expect(result).toEqual({ scanned: 21, drifted: 1, reconciled: 1 });
    expect(repo.findBySessionId("gone")?.status).toBe("lost");
    expect(cache.get("chan-gone").parentId).toBe("archive-cat");
    // ended の 20 行ぶん sessions を 1 行ずつ読み直さない (sessions は drift の JOIN でだけ読む)。
    const selectsOnSessions = prepare.mock.calls.filter(([sql]) => /FROM sessions\b/.test(String(sql)));
    expect(selectsOnSessions).toHaveLength(0);
  });
});
