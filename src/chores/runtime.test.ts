import Database from "better-sqlite3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChoresRuntime } from "./runtime.js";
import { spawnSession } from "../control/spawner.js";
vi.mock("../control/spawner.js", () => ({ spawnSession: vi.fn(() => ({ ok: true, pid: 123, command: [] })) }));
vi.mock("./cli.js", () => ({ executeChoreCli: vi.fn(async () => ({ ok: true, output: "結果", error: null })) }));
afterEach(() => vi.clearAllMocks());
describe("chore runtime handoff", () => {
  it("launches in the same dedicated cwd with a persisted handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "chores-"));
    const db = new Database(":memory:");
    const runtime = createChoresRuntime(db, () => root, () => false);
    try {
      const run = runtime.service.submit("human", "元の依頼", "codex");
      runtime.service.repo.transition(run, "succeeded", Date.now(), { output: "保存された結果" });
      const continued = await runtime.service.choose(run.id, "continue");
      expect(continued.status).toBe("continued");
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", cwd: run.cwd, spawnId: continued.spawn_id }));
      const handoff = await readFile(join(run.cwd, "continuation.md"), "utf8");
      expect(handoff).toContain("元の依頼"); expect(handoff).toContain("保存された結果");
    } finally { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
  });
});
