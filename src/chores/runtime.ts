import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { spawnSession } from "../control/spawner.js";
import { recordPendingDelegationSpawn, forgetPendingDelegationSpawnBySpawnId } from "../control/pending-delegation-spawns.js";
import { createChildLogger } from "../shared/logger.js";
import { ChoresRepository } from "./repository.js";
import { ChoresService } from "./service.js";
import { executeChoreCli } from "./cli.js";

export function createChoresRuntime(db: Database, workspaceRoot: () => string, isBlocked: () => boolean): { service: ChoresService; stop: () => Promise<void> } {
  const log = createChildLogger("chores");
  const service = new ChoresService(new ChoresRepository(db), {
    now: Date.now, id: randomUUID, cwd: (id) => join(workspaceRoot(), ".concordia-chores", id), isBlocked,
    execute: executeChoreCli,
    logError: (error) => log.error({ err: error }, "chore operation failed"),
    continue: async (run) => {
      if (!run.spawn_id) return { ok: false, error: "継続起動IDがありません。" };
      // Preparation failures are known not to have launched anything.
      try {
        await mkdir(run.cwd, { recursive: true });
        await writeFile(join(run.cwd, "continuation.md"), [
          "# 雑務からの継続", "依頼者がContinueを押しました。以下の元依頼・結果を確認して、続きを対話で進めてください。",
          "## 元の依頼", run.prompt, "## 実行結果（ツール出力）", run.output,
          "## エラー", run.error ?? "なし", `雑務ID: ${run.id}`,
        ].join("\n\n"), "utf8");
      } catch (error) { return { ok: false, error: String(error) }; }
      recordPendingDelegationSpawn({ cwd: run.cwd, spawnId: run.spawn_id, callName: "chore-continue" });
      const result = spawnSession({ provider: run.provider, cwd: run.cwd, cwdProvided: true,
        spawnId: run.spawn_id, title: "雑務の続き", args: ["continuation.mdを読み、元の雑務の続きを進めてください。"] });
      if (!result.ok) forgetPendingDelegationSpawnBySpawnId(run.spawn_id);
      return result.ok ? { ok: true } : result;
    },
  });
  const timer = setInterval(() => {
    try { service.tick(); } catch (error) { log.error({ err: error }, "chore queue tick failed"); }
  }, 2_000);
  timer.unref();
  return { service, stop: async () => { clearInterval(timer); await service.stop(); } };
}
