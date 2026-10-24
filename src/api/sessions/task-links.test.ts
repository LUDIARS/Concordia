import { expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SessionsRepo } from "../../db/sessions-repo.js";
import { registerTaskLinksRoutes } from "./task-links.js";
import { PatchSchema } from "./shared.js";

it("registers a scoped task link and reads live Actio status", async () => {
  const repo = new SessionsRepo(makeTestDb());
  repo.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "feature", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
  const app = new Hono();
  registerTaskLinksRoutes(app, { repo, taskStore: () => ({
    read: async (_repoPath: string, reference: string) => ({ path: reference, repoPath: "/repo", frontmatter: { actio_status: "done" } }),
  } as never) });
  const post = () => app.request("/s/task-links", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction_ref: "human-1", task_reference: "actio:T-1" }) });
  expect((await post()).status).toBe(201);
  expect((await post()).status).toBe(200);
  const response = await (await app.request("/s/task-links")).json();
  expect(response.links).toMatchObject([{ task_reference: "actio:T-1", status: "done" }]);
  expect(PatchSchema.safeParse({ metadata: { cc_task_links: [] } }).success).toBe(false);
});

it("links an in-scope task and keeps refusing an out-of-scope one with 403 (162bc3a6)", async () => {
  const repo = new SessionsRepo(makeTestDb());
  repo.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "fix/actio-x", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
  repo.patchSession("s", { target_project: "/actio" });
  const app = new Hono();
  registerTaskLinksRoutes(app, { repo, taskStore: () => ({
    readReference: async (repoPath: string, reference: string) => {
      if (repoPath !== "/repo" || reference !== "actio:IN-1") throw new Error("Actio task ownership mismatch");
      return { path: reference, repoPath: "/repo", frontmatter: { actio_status: "open", legacy_source: "cc-command" } };
    },
  } as never) });
  const post = (reference: string) => app.request("/s/task-links", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction_ref: "human-1", task_reference: reference }) });
  expect((await post("actio:IN-1")).status).toBe(201);
  const refused = await post("actio:OUT-1");
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "actio_task_out_of_scope" });
});
