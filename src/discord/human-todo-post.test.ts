import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { HUMAN_TODO_REPORT_KEY, readHumanTodoReport } from "../control/human-todo-digest.js";
import {
  DISCORD_HUMAN_TODO_PIN_KEY,
  postHumanTodoChange,
  readHumanTodoPin,
  resolveHumanTodoMention,
  type HumanTodoPostDeps,
} from "./human-todo-post.js";

type Change = Extract<ConcordiaEvent, { type: "session.human_todos_changed" }>;

const ADMIN = "123456789012345678";
const REQUESTER = "223456789012345678";

function harness(input: { metadata?: Record<string, unknown>; sendOk?: boolean; client?: boolean; configured?: string | null }) {
  const row = {
    id: "s", status: "active", metadata: JSON.stringify(input.metadata ?? {}),
  } as SessionRow;
  const sent: Array<Record<string, unknown>> = [];
  const pins: string[] = [];
  const unpins: string[] = [];
  const sessions = {
    findSession: (id: string) => (id === "s" ? row : null),
    updateMetadata: (id: string, fn: (current: Record<string, unknown>) => Record<string, unknown>) => {
      if (id === "s") row.metadata = JSON.stringify(fn(JSON.parse(row.metadata ?? "{}")));
    },
  } as Pick<SessionsRepo, "findSession" | "updateMetadata">;
  let next = 0;
  const deps: HumanTodoPostDeps = {
    webhooks: {
      getForSession: async () => (input.client === false ? null : ({ id: "hook" } as never)),
      send: async (_client, options) => {
        sent.push(options as Record<string, unknown>);
        next += 1;
        return input.sendOk === false ? null : { id: `m${next}`, channelId: "thread" };
      },
    },
    sessions,
    channelIdForSession: () => "thread",
    pin: async (_channel, message) => { pins.push(message); return true; },
    unpin: async (_channel, message) => { unpins.push(message); return true; },
    resolveMentionUserId: () => input.configured ?? null,
    log: { warn: () => undefined },
  };
  return { row, sent, pins, unpins, deps };
}

const report = (digest = "d1"): Change => ({
  type: "session.human_todos_changed", target_session_id: "s", change: "report",
  digest, item_count: 1, text: "🙋 **人間のやること** (1 件)\n1. [未回答の質問] @everyone 進めますか?", ts: 1,
});
const resolved: Change = {
  type: "session.human_todos_changed", target_session_id: "s", change: "resolved",
  digest: null, item_count: 0, text: "✅ 解消", ts: 2,
};

describe("人間のやることの Discord 投稿", () => {
  it("報告は 1 人だけをメンションして投稿し、ピン留めを記録する", async () => {
    const h = harness({ configured: ADMIN });
    expect(await postHumanTodoChange(h.deps, report())).toBe(true);
    expect(h.sent[0]!.content).toMatch(new RegExp(`^<@${ADMIN}> `));
    expect(h.sent[0]!.allowedMentions).toEqual({ parse: [], users: [ADMIN] });
    expect(h.pins).toEqual(["m1"]);
    expect(readHumanTodoPin(h.row.metadata)).toEqual({ channel_id: "thread", message_id: "m1" });
  });

  it("変化した報告は前回のピンを外して新しい投稿をピン留めする", async () => {
    const h = harness({ configured: ADMIN, metadata: { [DISCORD_HUMAN_TODO_PIN_KEY]: { channel_id: "thread", message_id: "old" } } });
    await postHumanTodoChange(h.deps, report("d2"));
    expect(h.unpins).toEqual(["old"]);
    expect(h.pins).toEqual(["m1"]);
    expect(readHumanTodoPin(h.row.metadata)?.message_id).toBe("m1");
  });

  it("解消はメンション無しで知らせ、ピンを外して記録を消す", async () => {
    const h = harness({ configured: ADMIN, metadata: { [DISCORD_HUMAN_TODO_PIN_KEY]: { channel_id: "thread", message_id: "old" } } });
    await postHumanTodoChange(h.deps, resolved);
    expect(h.sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(String(h.sent[0]!.content).startsWith("<@")).toBe(false);
    expect(h.unpins).toEqual(["old"]);
    expect(h.pins).toEqual([]);
    expect(readHumanTodoPin(h.row.metadata)).toBeNull();
  });

  it("送信に失敗した報告は control 側の記録を戻して次の巡回で再送させる", async () => {
    const h = harness({ sendOk: false, metadata: { [HUMAN_TODO_REPORT_KEY]: { digest: "d1", count: 1, reported_at: 1 } } });
    expect(await postHumanTodoChange(h.deps, report("d1"))).toBe(false);
    expect(readHumanTodoReport(h.row.metadata)).toBeNull();
    expect(h.pins).toEqual([]);
  });

  it("送信先が取れないときも記録を戻す", async () => {
    const h = harness({ client: false, metadata: { [HUMAN_TODO_REPORT_KEY]: { digest: "d1", count: 1, reported_at: 1 } } });
    expect(await postHumanTodoChange(h.deps, report("d1"))).toBe(false);
    expect(readHumanTodoReport(h.row.metadata)).toBeNull();
  });
});

describe("メンション先の決定", () => {
  it("設定値 → 依頼者の順で、不正な値は使わない", () => {
    const metadata = JSON.stringify({ discord_requester_user_id: REQUESTER });
    expect(resolveHumanTodoMention({ configured: ADMIN, metadata })).toBe(ADMIN);
    expect(resolveHumanTodoMention({ configured: null, metadata })).toBe(REQUESTER);
    expect(resolveHumanTodoMention({ configured: "<@everyone>", metadata })).toBe(REQUESTER);
    expect(resolveHumanTodoMention({ configured: null, metadata: JSON.stringify({ discord_requester_user_id: "x" }) })).toBeNull();
    expect(resolveHumanTodoMention({ configured: null, metadata: "broken" })).toBeNull();
  });
});
