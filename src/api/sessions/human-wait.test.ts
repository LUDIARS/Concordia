import { expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SessionsRepo } from "../../db/sessions-repo.js";
import { registerHumanWaitRoutes } from "./human-wait.js";
import { PatchSchema } from "./shared.js";

it("records an explicit human wait through its dedicated route", async () => {
  const repo = new SessionsRepo(makeTestDb());
  repo.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "feature", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
  const app = new Hono();
  registerHumanWaitRoutes(app, { repo });
  const response = await app.request("/s/human-wait", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "判断待ち", task_references: ["actio:T-1"] }) });
  expect(response.status).toBe(200);
  expect((await (await app.request("/s/human-wait")).json()).human_wait).toMatchObject({
    active: true, summary: "判断待ち", task_references: ["actio:T-1"],
  });
  expect(PatchSchema.safeParse({ metadata: { cc_human_wait: null } }).success).toBe(false);
});
