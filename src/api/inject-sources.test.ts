import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { MajorInjectEditor } from "../control/major-inject-editor.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { InjectManualsRepo } from "../db/inject-manuals-repo.js";
import { MajorInjectRepo } from "../db/major-inject-repo.js";
import { injectSourcesRouter } from "./inject-sources.js";

describe("major inject source API", () => {
  it("returns catalog and detail, then rejects stale revision with current source", async () => {
    const db = makeTestDb();
    const app = injectSourcesRouter(new MajorInjectEditor(
      new MajorInjectRepo(db), new InjectManualsRepo(db), new DelegationRepo(db),
    ));
    const catalog = await app.request("/");
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "session.work_policy", apply_scope: "next_startup_policy" }),
    ]));
    const original = (await (await app.request("/session.work_policy")).json()).source;
    const body = JSON.stringify({ content: "改訂版", expected_revision: original.revision });
    const saved = await app.request("/session.work_policy", { method: "PUT", body,
      headers: { "Content-Type": "application/json" } });
    expect(saved.status).toBe(200);
    const conflict = await app.request("/session.work_policy", { method: "PUT", body,
      headers: { "Content-Type": "application/json" } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).source.content).toBe("改訂版");
  });
});
