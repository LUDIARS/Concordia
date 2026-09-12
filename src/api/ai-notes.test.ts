import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { aiNotesRouter } from "./ai-notes.js";
import { MIGRATIONS } from "../db/schema.js";
import { SqlitePublicationStore } from "../db/ai-note-publication.js";
import { PublicationService } from "../ai-notes/publication-service.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const article = { page_id: "3d839cbf-bab9-8174-bb4e-f6787481efc9", title: "記事",
  url: "https://app.notion.com/p/3d839cbfbab98174bb4ef6787481efc9" };
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  MIGRATIONS.find(migration => migration.name === "ai-note-publication")!.up(db);
  const store = new SqlitePublicationStore(db);
  const send = vi.fn().mockResolvedValue({ status: "failed", error_code: "http_403" });
  const app = aiNotesRouter(new PublicationService(store, { send, verify: async () => null }, () => 1_000, () => "attempt"));
  return { store, send, post: (path: string, body: unknown) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) };
}

it("previews without posting or recording a publication", async () => {
  const { store, send, post } = setup();
  const response = await post("/preview", article);
  expect(response.status).toBe(200);
  expect((await response.json()).article.page_id).toBe(article.page_id.replace(/-/g, ""));
  expect(store.list(article.page_id.replace(/-/g, ""))).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});

it("rejects unconfigured publication and invalid article links before sending", async () => {
  const { send, post } = setup();
  expect((await post("/publications", article)).status).toBe(409);
  expect((await post("/publications", { ...article, url: "https://example.com" })).status).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

it("does not report a rejected notification as successfully sent", async () => {
  const { store, post } = setup();
  store.replaceTargets([{ kind: "discord-channel", guild_id: "111111111111111111", channel_id: "222222222222222222" }]);
  const response = await post("/publications", article);
  expect(await response.json()).toMatchObject({ ok: false, publications: [{ status: "failed", receipt: null }] });
});
