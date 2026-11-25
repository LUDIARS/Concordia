import { expect, it } from "vitest";
import { makeTestApp } from "../../../tests/helpers/test-app.js";
import { createCardSources } from "../../control-cards/sources.js";

it("accepts a pending question action and exposes it through the ask card source", async () => {
  const { app, repo, db } = makeTestApp();
  repo.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "feature", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
  const response = await app.request("/v1/sessions/s/pending-question", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "承認しますか？", options: ["はい", "いいえ"], human_action: " #4194 を通すか決める " }),
  });
  expect(response.status).toBe(200);
  const { question_id } = await response.json();
  const sources = createCardSources(db, { projectOf: () => "Cc", webUrl: path => path });
  const ask = sources.read().find(source => source.kind === "ask-card");
  expect(ask).toMatchObject({ readable: true, items: [{ source_key: `ask-card:${question_id}`, human_action: "#4194 を通すか決める" }] });
});
