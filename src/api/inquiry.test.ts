import { describe, expect, it } from "vitest";
import { inquiryRouter } from "./inquiry.js";
import type { GeniusClient } from "../inquiry/genius-client.js";
import { eventBus } from "../events.js";
import type { PendingQuestionProbe } from "../control/pending-question-blocker.js";

function appWith(input: {
  genius: GeniusClient;
  metadata?: string | null;
  now?: () => number;
  hasPendingQuestion?: PendingQuestionProbe;
}) {
  return inquiryRouter({
    sessions: {
      findSession: () => ({ id: "lictor-1", metadata: input.metadata ?? null, status: "active" }),
      appendEvent: () => undefined,
    } as never,
    config: { inquiryScoreMin: 0.6, inquiryCacheSec: 60, defaultSupervisor: "" } as never,
    genius: input.genius,
    now: input.now,
    hasPendingQuestion: input.hasPendingQuestion,
  });
}

function post(app: ReturnType<typeof inquiryRouter>, body: Record<string, unknown>) {
  return app.request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "lictor-1", category: "タスク", context: "完了", ...body }),
  });
}

describe("POST /v1/inquiry", () => {
  it("returns self_judge when the Genius delegate is unavailable", async () => {
    // Genius 不在 = 代行者不在。 Cc が代わりに推測せず、 セッションの通常判断へ委ねる。
    const app = appWith({ genius: { query: async () => null } });

    const response = await post(app, {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      decision: "self_judge",
      genius_available: false,
    });
  });

  it("rejects an unknown category", async () => {
    const app = appWith({ genius: { query: async () => null } });
    const response = await post(app, { category: "未知" });
    expect(response.status).toBe(400);
  });

  it("pins the decision to ask_human after the goal-and-go limit stopped the session", async () => {
    // spec §8: 上限到達 (stopped_reason 有り) 後のタスクお伺いは、 前例がどうであれ
    // 人間に上げる (暴走の最終防波堤)。
    const genius: GeniusClient = {
      query: async () => [{ score: 0.9, decision: "proceed" }] as never,
    };
    const app = appWith({
      genius,
      metadata: JSON.stringify({
        goal_and_go: {
          enabled: true,
          continuation_count: 6,
          started_at: 1,
          last_continued_at: 2,
          stopped_reason: "continuation_limit",
        },
      }),
    });

    const response = await post(app, {});

    await expect(response.json()).resolves.toMatchObject({ decision: "ask_human" });
  });

  it("does not inject an automatic inquiry while a question is unanswered", async () => {
    const app = appWith({
      genius: { query: async () => null },
      hasPendingQuestion: () => true,
    });
    const injected: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === "auto:inquiry") injected.push(event.text);
    });

    await post(app, {});

    expect(injected).toEqual([]);
    unsubscribe();
  });

  it("injects a cached inquiry once after the pending question is answered", async () => {
    let blocked = true;
    let calls = 0;
    const app = appWith({
      genius: { query: async () => { calls += 1; return null; } },
      hasPendingQuestion: () => blocked,
      now: () => 100,
    });
    const injected: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === "auto:inquiry") injected.push(event.text);
    });

    await post(app, {});
    blocked = false;
    await post(app, {});
    await post(app, {});

    expect(calls).toBe(1);
    expect(injected).toHaveLength(1);
    unsubscribe();
  });

  it("serves the cached record for the same (session, category) within the window", async () => {
    let calls = 0;
    const genius: GeniusClient = {
      query: async () => {
        calls += 1;
        return null;
      },
    };
    const app = appWith({ genius, now: () => 100 });

    const first = await (await post(app, {})).json() as { inquiry_id: string };
    const second = await (await post(app, {})).json() as { inquiry_id: string };

    expect(calls).toBe(1);
    expect(second.inquiry_id).toBe(first.inquiry_id);
  });
});
