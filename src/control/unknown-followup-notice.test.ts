/** @implements spec/feature/task-linked-followup.md — unknown の理由を一度示し、同じ unknown を繰り返さない */
import { describe, expect, it } from "vitest";
import { eventBus } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionFollowupSnapshot } from "./session-followup-state.js";
import { startStalledSessionNudge } from "./stalled-session-nudge.js";
import {
  isUnknownFollowupAlreadyShown,
  readUnknownFollowupNotice,
  unknownFollowupNoticeKey,
  writeUnknownFollowupNotice,
} from "./unknown-followup-notice.js";

const unlinked: SessionFollowupSnapshot = {
  workflow: "revisor", tasks: [], delegations: [], prs: [], unavailable: [],
  linkFailures: [{ task_reference: "actio:162bc3a6", reason: "task_out_of_scope" }],
};

function fakeRepo(row: SessionRow): SessionsRepo {
  const update = (_id: string, fn: (current: Record<string, unknown>) => Record<string, unknown>) => {
    row.metadata = JSON.stringify(fn(JSON.parse(row.metadata ?? "{}")));
  };
  return {
    findAllActive: () => [row],
    findSession: () => row,
    updateMetadata: update,
    mergeMetadata: (id: string, patch: Record<string, unknown>) => update(id, (current) => ({ ...current, ...patch })),
  } as unknown as SessionsRepo;
}

describe("unknownFollowupNoticeKey", () => {
  it("is null outside unknown and stable for the same unknown content", () => {
    expect(unknownFollowupNoticeKey("task-active", unlinked)).toBeNull();
    expect(unknownFollowupNoticeKey("unknown", unlinked)).toBe(unknownFollowupNoticeKey("unknown", { ...unlinked }));
    expect(unknownFollowupNoticeKey("unknown", undefined)).not.toBeNull();
  });

  it("changes when the reason, the refused reference or an unavailable source changes", () => {
    const base = unknownFollowupNoticeKey("unknown", unlinked);
    expect(unknownFollowupNoticeKey("unknown", { ...unlinked, linkFailures: [{ task_reference: "actio:other", reason: "not_found" }] })).not.toBe(base);
    expect(unknownFollowupNoticeKey("unknown", { ...unlinked, tasks: [{ status: "unknown", reason: "task_unavailable" }] })).not.toBe(base);
    expect(unknownFollowupNoticeKey("unknown", { ...unlinked, unavailable: ["actio"] })).not.toBe(base);
  });

  it("suppresses only the same, already shown unknown", () => {
    expect(isUnknownFollowupAlreadyShown("k", "k")).toBe(true);
    expect(isUnknownFollowupAlreadyShown("k", "j")).toBe(false);
    expect(isUnknownFollowupAlreadyShown("k", null)).toBe(false);
    expect(isUnknownFollowupAlreadyShown(null, null)).toBe(false);
  });

  it("stores the shown key and clears it after a non-unknown followup", () => {
    const row = { id: "s", metadata: JSON.stringify({ keep: 1 }) } as SessionRow;
    const repo = fakeRepo(row);
    writeUnknownFollowupNotice(repo, "s", "k", null);
    expect(readUnknownFollowupNotice(row.metadata)).toBe("k");
    writeUnknownFollowupNotice(repo, "s", null, "k");
    expect(readUnknownFollowupNotice(row.metadata)).toBeNull();
    expect(JSON.parse(row.metadata!)).toEqual({ keep: 1 });
    expect(readUnknownFollowupNotice("broken")).toBeNull();
  });
});

describe("stalled-session nudge with an unlinkable task (162bc3a6)", () => {
  async function run(snapshots: SessionFollowupSnapshot[]) {
    let clock = 10_000_000;
    let mtime = 0;
    let round = 0;
    const row = {
      id: "u", provider: "claude-code", repo_path: "/r", repo_origin: null, branch: null, host: "h",
      started_at: 0, ended_at: null, status: "active", last_seen_at: 0, current_task: null,
      transcript_path: null, metadata: null, ws_clients: 0,
    } as SessionRow;
    const injected: string[] = [];
    const off = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === "u") injected.push(event.text);
    });
    const h = startStalledSessionNudge({
      repo: fakeRepo(row),
      now: () => clock,
      transcriptMtimeMs: async () => mtime,
      readTranscriptTail: async () => JSON.stringify({ role: "assistant", content: "確認しました。" }),
      resolveWorkState: async () => snapshots[Math.min(round, snapshots.length - 1)]!,
      idleSec: 600,
      cooldownSec: 600,
      intervalMs: 1_000_000,
    });
    try {
      for (; round < snapshots.length; round += 1) {
        await h.runOnce();
        mtime = clock + 60_000; // the session answers every time
        clock += 3_600_000;
      }
    } finally {
      h.stop();
      off();
    }
    return injected;
  }

  it("shows the reason once instead of repeating the same unknown", async () => {
    const injected = await run([unlinked, unlinked, unlinked, unlinked]);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("state=unknown");
    expect(injected[0]).toContain("actio:162bc3a6 (task_out_of_scope)");
  });

  it("shows unknown again once its content changes or after a known state", async () => {
    const other = { ...unlinked, linkFailures: [{ task_reference: "actio:other", reason: "not_found" }] };
    const active: SessionFollowupSnapshot = { workflow: "revisor", tasks: [{ status: "in_progress" }], delegations: [], prs: [] };
    const injected = await run([unlinked, other, other, active, other]);
    expect(injected.map((text) => /state=(\S+)/.exec(text)?.[1])).toEqual(["unknown", "unknown", "task-active", "unknown"]);
  });
});
