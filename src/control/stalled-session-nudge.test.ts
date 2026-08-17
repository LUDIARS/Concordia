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
  it("末尾の assistant が ask マーカー → awaiting=true", async () => {
    const tail = jsonl(
      { role: "user", content: "やって" },
      { role: "assistant", content: "どちらにしますか？\n```ask\n{\"question\":\"A or B\"}\n```" },
    );
    expect(isAwaitingHumanInput(tail)).toBe(true);
  });

  it("ask の後に user 回答が来ている → awaiting=false (回答済み)", async () => {
    const tail = jsonl(
      { role: "assistant", content: "```ask\n{\"question\":\"A or B\"}\n```" },
      { role: "user", content: "A で" },
    );
    expect(isAwaitingHumanInput(tail)).toBe(false);
  });

  it("普通の assistant 出力 (ask 無し) → awaiting=false", async () => {
    const tail = jsonl(
      { role: "user", content: "やって" },
      { role: "assistant", content: "実装しました。次に進みます。" },
    );
    expect(isAwaitingHumanInput(tail)).toBe(false);
  });

  it("content 配列形式の ask マーカーも拾う", async () => {
    const tail = jsonl({
      role: "assistant",
      content: [{ type: "text", text: "確認です\n```ask\n{}\n```" }],
    });
    expect(isAwaitingHumanInput(tail)).toBe(true);
  });

  it("JSONL でない生テキストでも末尾に ask フェンスがあれば true", async () => {
    expect(isAwaitingHumanInput("質問です\n```ask\n{}\n```")).toBe(true);
  });

  it("空 / null は false", async () => {
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
  it("idle 閾値到達 + 非 awaiting + cooldown 無し → true", async () => {
    expect(shouldNudge(base)).toBe(true);
  });
  it("idle 閾値未満 → false", async () => {
    expect(shouldNudge({ ...base, idleMs: 3_599_000 })).toBe(false);
  });
  it("awaiting → false", async () => {
    expect(shouldNudge({ ...base, awaiting: true })).toBe(false);
  });
  it("cooldown 内 → false", async () => {
    expect(shouldNudge({ ...base, lastNudgeMs: base.nowMs - 100 })).toBe(false);
  });
  it("cooldown 経過 → true", async () => {
    expect(shouldNudge({ ...base, lastNudgeMs: base.nowMs - 3_600_001 })).toBe(true);
  });
});

describe("buildNudgeText", () => {
  it("再実装の後押し / ask 停止の指示を含む", async () => {
    const t = buildNudgeText("claude-code");
    expect(t).toContain("再実装");
    expect(t).toContain("worktree");
    expect(t).toContain("delegation");
    expect(t).toContain("ask");
  });

  it("終了指示ではないことを明示し、自発 session-end を禁じる", async () => {
    const t = buildNudgeText("claude-code");
    expect(t).toContain("終了指示ではありません");
    // 「残作業が無ければ /session-end しろ」 という終了許可の読み方を残さない。
    expect(t).not.toMatch(/残作業が無ければ.*session-end/);
    expect(t).toContain("自分で `/session-end` を実行しないでください");
    expect(t).toContain("待機");
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

  it("1 時間以上 idle で非 awaiting の session を nudge する", async () => {
    const s = fakeSession({ id: "idle-1" });
    const h = startStalledSessionNudge({
      repo: fakeRepo([s]),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 3_700_000, // ~61 分前
      readTranscriptTail: async () => jsonl({ role: "assistant", content: "完了。" }),
      intervalMs: 1_000_000,
    });
    const nudged = await h.runOnce();
    h.stop();
    expect(nudged).toEqual(["idle-1"]);
    const ev = injects()[0];
    expect(ev.target_session_id).toBe("idle-1");
    expect(ev.source).toBe(STALL_NUDGE_SOURCE);
  });

  it("goal metadata に関係なく同じ協働復帰 nudge を流す", async () => {
    const s = fakeSession({ id: "watch-1", metadata: JSON.stringify({ goal: { mode: "watch" } }) });
    const h = startStalledSessionNudge({
      repo: fakeRepo([s]),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 3_700_000,
      readTranscriptTail: async () => jsonl({ role: "assistant", content: "完了。" }),
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual(["watch-1"]);
    h.stop();
    const ev = injects()[0];
    expect(ev.text).toContain("再実装");
    expect(ev.text).toContain("worktree");
  });

  it("idle が閾値未満なら nudge しない", async () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "fresh" })]),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 300_000, // 5 分前 (既定 idle 閾値 600 秒未満)
      readTranscriptTail: async () => "",
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
  });

  it("ask で人間判断待ちの session は除外する", async () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "waiting" })]),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 7_200_000, // 2h idle
      readTranscriptTail: async () => jsonl({ role: "assistant", content: "```ask\n{}\n```" }),
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
  });

  it("未回答の Cc 質問カードがある session は除外する (ask マーカーが無くても)", async () => {
    let tailReads = 0;
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "card-waiting" })]),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 7_200_000, // 2h idle
      readTranscriptTail: async () => {
        tailReads++;
        return jsonl({ role: "assistant", content: "どうしますか。" });
      },
      hasPendingQuestion: () => true,
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
    // 質問カード判定は transcript 読みより前に効く (無駄な tail 読みをしない)。
    expect(tailReads).toBe(0);
  });

  it("質問カードが回答済みなら通常どおり nudge する", async () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "card-answered" })]),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 7_200_000,
      readTranscriptTail: async () => jsonl({ role: "assistant", content: "完了。" }),
      hasPendingQuestion: () => false,
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual(["card-answered"]);
    h.stop();
  });

  it("質問カードの照会に失敗した session は安全側で除外し、走査を続ける", async () => {
    const sessions = [fakeSession({ id: "lookup-failed" }), fakeSession({ id: "next-session" })];
    const h = startStalledSessionNudge({
      repo: fakeRepo(sessions),
      now: () => NOW,
      transcriptMtimeMs: async () => NOW - 7_200_000,
      readTranscriptTail: async () => jsonl({ role: "assistant", content: "完了。" }),
      hasPendingQuestion: (sessionId) => {
        if (sessionId === "lookup-failed") throw new Error("question lookup failed");
        return false;
      },
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual(["next-session"]);
    h.stop();
  });

  it("transcript 不明 (mtime null) は計測不能としてスキップ", async () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "no-transcript" })]),
      now: () => NOW,
      transcriptMtimeMs: async () => null,
      readTranscriptTail: async () => null,
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual([]);
    h.stop();
  });

  it("cooldown 内は再 nudge しない (2 回目は空)", async () => {
    let clock = NOW;
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "idle-1" })]),
      now: () => clock,
      transcriptMtimeMs: async () => 0, // 常に大きく idle
      readTranscriptTail: async () => jsonl({ role: "assistant", content: "完了。" }),
      idleSec: 3600,
      cooldownSec: 3600,
      intervalMs: 1_000_000,
    });
    expect(await h.runOnce()).toEqual(["idle-1"]);
    clock += 60_000; // 1 分後
    expect(await h.runOnce()).toEqual([]); // cooldown 内
    clock += 3_600_001; // cooldown 経過
    expect(await h.runOnce()).toEqual(["idle-1"]);
    h.stop();
  });

  it("enabled=false なら何もしない", async () => {
    const h = startStalledSessionNudge({
      repo: fakeRepo([fakeSession({ id: "idle-1" })]),
      enabled: false,
      now: () => NOW,
      transcriptMtimeMs: async () => 0,
      readTranscriptTail: async () => "",
    });
    expect(await h.runOnce()).toEqual([]);
    h.stop();
    expect(injects().length).toBe(0);
  });
});
