import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import {
  isAwaitingHumanInput,
  shouldNudge,
  buildNudgeText,
  startStalledSessionNudge,
  STALL_NUDGE_SOURCE,
} from "./stalled-session-nudge.js";

function fakeSession(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    provider: "claude-code",
    repo_path: "/r",
    repo_origin: null,
    branch: null,
    host: "h",
    started_at: 0,
    ended_at: null,
    status: "active",
    last_seen_at: 0,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    ...over,
  } as SessionRow;
}

/** active session のみ返す最小 repo stub。 */
function fakeRepo(active: SessionRow[]): SessionsRepo {
  return { findAllActive: () => active } as unknown as SessionsRepo;
}

const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

describe("isAwaitingHumanInput", () => {
  it("末尾の assistant が ask マーカー → awaiting=true", () => {
    const tail = jsonl(
      { role: "user", content: "やって" },
      { role: "assistant", content: "どちらにしますか？\n```ask\n{\"question\":\"A or B\"}\n```" },
    );
    expect(isAwaitingHumanInput(tail)).toBe(true);
  });

  it("ask の後に user 回答が来ている → awaiting=false (回答済み)", () => {
    const tail = jsonl(
      { role: "assistant", content: "```ask\n{\"question\":\"A or B\"}\n```" },
      { role: "user", content: "A で" },
    );
    expect(isAwaitingHumanInput(tail)).toBe(false);
  });

  it("普通の assistant 出力 (ask 無し) → awaiting=false", () => {
    const tail = jsonl(
      { role: "user", content: "やって" },
      { role: "assistant", content: "実装しました。次に進みます。" },
    );
    expect(isAwaitingHumanInput(tail)).toBe(false);
  });

  it("content 配列形式の ask マーカーも拾う", () => {
    const tail = jsonl({
      role: "assistant",
      content: [{ type: "text", text: "確認です\n```ask\n{}\n```" }],
    });
    expect(isAwaitingHumanInput(tail)).toBe(true);
  });

  it("JSONL でない生テキストでも末尾に ask フェンスがあれば true", () => {
    expect(isAwaitingHumanInput("質問です\n```ask\n{}\n```")).toBe(true);
  });

  it("空 / null は false", () => {
    expect(isAwaitingHumanInput(null)).toBe(false);
    expect(isAwaitingHumanInput("")).toBe(false);
  });
});

describe("shouldNudge", () => {
  const base = {
    idleMs: 3_600_000,
    idleThresholdMs: 3_600_000,
    awaiting: false,
    lastNudgeMs: null,
    cooldownMs: 3_600_000,
    nowMs: 10_000_000,
  };
  it("idle 閾値到達 + 非 awaiting + cooldown 無し → true", () => {
    expect(shouldNudge(base)).toBe(true);
  });
  it("idle 閾値未満 → false", () => {
    expect(shouldNudge({ ...base, idleMs: 3_599_000 })).toBe(false);
  });
  it("awaiting → false", () => {
    expect(shouldNudge({ ...base, awaiting: true })).toBe(false);
  });
  it("cooldown 内 → false", () => {
    expect(shouldNudge({ ...base, lastNudgeMs: base.nowMs - 100 })).toBe(false);
  });
  it("cooldown 経過 → true", () => {
    expect(shouldNudge({ ...base, lastNudgeMs: base.nowMs - 3_600_001 })).toBe(true);
  });
});

describe("buildNudgeText", () => {
  it("残作業続行 / ask 停止 / session-end の 3 指示を含む", () => {
    const t = buildNudgeText("claude-code");
    expect(t).toContain("残作業がなくなるまで実装");
    expect(t).toContain("ask");
    expect(t).toContain("/session-end");
  });
});

describe("startStalledSessionNudge.runOnce", () => {
  let received: Array<Record<string, unknown>> = [];
  let unsub: (() => void) | null = null;
  const NOW = 100_000_000;

  beforeEach(() => {
    received = [];
    unsub = eventBus.subscribe((ev) => received.push(ev as Record<string, unknown>));
  });
  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  function injects() {
    return received.filter((e) => e.type === "session.inject");
  }

  it("1 時間以上 idle で非 awaiting の session を nudge する", () => {
    const s = fakeSession({ id: "idle-1" });
    const h = startStalledSessionNudge({
      repo: fakeRepo([s]),
      now: () => NOW,
      transcriptMtimeMs: () => NOW - 3_700_000, // ~61 分前
      readTranscriptTail: () => jsonl({ role: "assistant", content: "完了。" }),
      intervalMs: 1_000_000,
    });
    const nudged = h.runOnce();
    h.stop();
    expect(nudged).toEqual(["idle-1"]);
    const ev = injects()[0];
    expect(ev.target_session_id).toBe("idle-1");
    expect(ev.source).toBe(STALL_NUDGE_SOURCE);
  });

  it("idle が閾値未満なら nudge しない", () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "fresh" })]),
      now: () => NOW,
      transcriptMtimeMs: () => NOW - 1_000_000, // ~16 分前
      readTranscriptTail: () => "",
      intervalMs: 1_000_000,
    });
    expect(h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
  });

  it("ask で人間判断待ちの session は除外する", () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "waiting" })]),
      now: () => NOW,
      transcriptMtimeMs: () => NOW - 7_200_000, // 2h idle
      readTranscriptTail: () => jsonl({ role: "assistant", content: "```ask\n{}\n```" }),
      intervalMs: 1_000_000,
    });
    expect(h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
  });

  it("transcript 不明 (mtime null) は計測不能としてスキップ", () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "no-transcript" })]),
      now: () => NOW,
      transcriptMtimeMs: () => null,
      readTranscriptTail: () => null,
      intervalMs: 1_000_000,
    });
    expect(h.runOnce()).toEqual([]);
    h.stop();
  });

  it("cooldown 内は再 nudge しない (2 回目は空)", () => {
    let clock = NOW;
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "idle-1" })]),
      now: () => clock,
      transcriptMtimeMs: () => 0, // 常に大きく idle
      readTranscriptTail: () => jsonl({ role: "assistant", content: "完了。" }),
      idleSec: 3600,
      cooldownSec: 3600,
      intervalMs: 1_000_000,
    });
    expect(h.runOnce()).toEqual(["idle-1"]);
    clock += 60_000; // 1 分後
    expect(h.runOnce()).toEqual([]); // cooldown 内
    clock += 3_600_001; // cooldown 経過
    expect(h.runOnce()).toEqual(["idle-1"]);
    h.stop();
  });

  it("enabled=false なら何もしない", () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "idle-1" })]),
      enabled: false,
      now: () => NOW,
      transcriptMtimeMs: () => 0,
      readTranscriptTail: () => "",
    });
    expect(h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
  });
});
