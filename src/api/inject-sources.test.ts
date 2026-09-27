import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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

  it("recovers from a conflict after a read-only source GET without opening history first", async () => {
    const db = makeTestDb();
    const manuals = new InjectManualsRepo(db);
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), manuals, new DelegationRepo(db));
    const app = injectSourcesRouter(editor);
    const id = "delegation.manual.review";
    const initial = (await (await app.request(`/${id}`)).json()).source;
    expect(initial.history_version_id).toBeNull();
    manuals.upsert("レビュー", "外部編集");
    const write = (content: string, source: { revision: string; history_version_id: number | null }) =>
      app.request(`/${id}`, { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, expected_revision: source.revision,
          expected_version_id: source.history_version_id }) });
    const rejected = await write("古い下書き", initial);
    expect(rejected.status).toBe(409);
    const observed = (await rejected.json()).source;
    expect(observed.content).toBe("外部編集");
    expect(typeof observed.history_version_id).toBe("number");
    const reloaded = (await (await app.request(`/${id}`)).json()).source;
    expect(reloaded.history_version_id).toBe(observed.history_version_id);
    const saved = await write("新しい下書き", reloaded);
    expect(saved.status).toBe(200);
    expect((await saved.json()).source.content).toBe("新しい下書き");
  });

  it("returns an imported baseline and a parent diff, then restores by adding a version", async () => {
    const db = makeTestDb();
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), new InjectManualsRepo(db), new DelegationRepo(db));
    const app = injectSourcesRouter(editor);
    const id = "delegation.manual.review";
    const initial = (await (await app.request(`/${id}`)).json()).source;
    const firstPage = await (await app.request(`/${id}/history`)).json();
    expect(firstPage.versions).toHaveLength(1);
    const baseline = firstPage.versions[0];
    const save = await app.request(`/${id}`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "new manual", expected_revision: initial.revision,
        expected_version_id: baseline.version_id }) });
    expect(save.status).toBe(200);
    const changed = (await save.json()).source;
    const detail = await (await app.request(`/${id}/history/${changed.history_version_id}`)).json();
    expect(detail).toMatchObject({ version: { content: "new manual" }, parent: { content: initial.content } });
    const restored = await app.request(`/${id}/history/${baseline.version_id}/restore`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: changed.revision, expected_version_id: changed.history_version_id }),
    });
    expect(restored.status).toBe(200);
    expect((await restored.json()).source.content).toBe(initial.content);
    expect((await (await app.request(`/${id}/history`)).json()).versions[0].change_kind).toBe("restore_version");
  });

  it("requires explicit acceptance of an uncertain file result without retrying the file write", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-inject-history-"));
    try {
      await mkdir(join(root, "rule"));
      const file = join(root, "rule", "session-work.md");
      await writeFile(file, "original", "utf8");
      const db = makeTestDb();
      const repo = new MajorInjectRepo(db);
      const editor = new MajorInjectEditor(repo, new InjectManualsRepo(db), new DelegationRepo(db), root);
      const app = injectSourcesRouter(editor);
      const id = "rules.session_work";
      const baseline = (await editor.history(id)).versions[0]!;
      const operationId = randomUUID();
      repo.history.addOperation({ operation_id: operationId, target_id: id,
        parent_version_id: baseline.version_id, expected_revision: baseline.revision,
        desired_revision: createHash("sha256").update("external current").digest("hex"),
        content: "external current", actor: "unknown", change_kind: "edit", created_at: 1 });
      await writeFile(file, "external current", "utf8");
      const history = await (await app.request(`/${id}/history`)).json();
      expect(history.pending).toMatchObject({ operation_id: operationId, status: "uncertain" });
      const current = (await (await app.request(`/${id}`)).json()).source;
      const request = () => app.request(`/${id}/history/file-outcome/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation_id: operationId, expected_revision: current.revision,
          expected_version_id: current.history_version_id }),
      });
      const lockPath = `${file}.cc-inject.lock`;
      await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
      expect((await request()).status).toBe(409);
      await rm(lockPath);
      const stalePid = 999_999_999;
      await writeFile(lockPath, JSON.stringify({ pid: stalePid }));
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === stalePid) {
          rmSync(lockPath);
          writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
          throw Object.assign(new Error("stale process"), { code: "ESRCH" });
        }
        throw new Error("unexpected process check");
      });
      try { expect((await request()).status).toBe(409); }
      finally { kill.mockRestore(); }
      expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(process.pid);
      await rm(lockPath);
      const response = await request();
      expect(response.status).toBe(200);
      expect(repo.history.operation(operationId)?.status).toBe("resolved");
      expect((await (await app.request(`/${id}/history`)).json()).versions[0].change_kind).toBe("resolve_file_outcome");
      expect(await readFile(file, "utf8")).toBe("external current");
    } finally {
      const target = resolve(root);
      if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe test cleanup path");
      await rm(target, { recursive: true, force: true });
    }
  });
});
