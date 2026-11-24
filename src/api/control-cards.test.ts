import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createHumanCommandCards } from "../control-cards/human-command-cards.js";
import { ControlCardsRepository } from "../control-cards/repository.js";
import { ControlCardsService } from "../control-cards/service.js";
import type { Dialogue } from "../sprint-dialogues/domain.js";
import { controlCardsRouter } from "./control-cards.js";
import { parseHumanCommandRequests } from "../discord/human-command-marker.js";

function setup() {
  const repo = new ControlCardsRepository(makeTestDb());
  let seq = 0;
  const humanCommands = createHumanCommandCards({ repo, parse: parseHumanCommandRequests, now: () => 1, id: () => `card-${++seq}`, projectOf: () => "Cc", webUrl: (p) => p, log: { warn: () => {} } });
  const service = new ControlCardsService(repo, humanCommands, () => 5);
  const ask = repo.open("ask-1", { source_kind: "ask-card", source_key: "ask-card:1", summary: "質問", raised_at: 1, session_id: "s1", project: "Cc", link: "/sessions/s1" }, 1);
  humanCommands.onSessionMessage({ sessionId: "s1", messageId: 7, authorType: "assistant", content: "`! gh auth login` を打ってください" });
  const sprint = { projection: { dialogueKey: "actio:t:s", teamId: "t", sprintId: "s", sprintName: "Sprint 1", phase: "planning", held: false, closed: false, taskIds: ["a", "b"], summary: "要約", actioPath: "/tasks/planning", revision: 2 } } as unknown as Dialogue;
  const app = controlCardsRouter({ service, sprints: () => [sprint] });
  const patch = (id: string, body: unknown) => app.request(`/cards/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, patch, ask, repo };
}

describe("/v1/control/cards と /v1/control/sprints", () => {
  it("lists open cards and lets a human change only the triage fields", async () => {
    const { app, patch, ask } = setup();
    expect((await (await app.request("/cards")).json()).cards).toHaveLength(2);
    const response = await patch(ask.id, { priority: "high", assignee: "neco", remind_at: "2026-11-25T09:00:00+09:00", reminder_text: "朝に", group: "" });
    expect(response.status).toBe(200);
    expect((await response.json()).card).toMatchObject({ priority: "high", assignee: "neco", remind_at: Date.parse("2026-11-25T00:00:00Z"), reminder_text: "朝に", card_group: null, triaged_by: "human:web" });
    expect((await patch(ask.id, { state: "closed" })).status).toBe(400);
    expect((await patch(ask.id, {})).status).toBe(400);
  });

  it("closes only human-command cards with done; source-owned cards are resolved at the source (CC-V5-INV-02)", async () => {
    const { app, patch, ask, repo } = setup();
    expect((await patch(ask.id, { done: true })).status).toBe(409);
    const human = repo.findBySource("human-command", "7:0")!;
    const done = await patch(human.id, { done: true, actor: "neco" });
    expect((await done.json()).card).toMatchObject({ state: "closed", close_reason: "done_by:neco" });
    expect((await patch(human.id, { priority: "low" })).status).toBe(409);
    expect((await patch("missing", { priority: "low" })).status).toBe(404);
    expect((await (await app.request("/cards?state=closed")).json()).cards).toHaveLength(1);
  });

  it("returns sprint projections read-only", async () => {
    const { app } = setup();
    expect((await (await app.request("/sprints")).json()).sprints).toEqual([expect.objectContaining({ sprint_name: "Sprint 1", task_count: 2, closed: false })]);
    expect((await app.request("/sprints", { method: "POST" })).status).toBe(404);
  });
});
