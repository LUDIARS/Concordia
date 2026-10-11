/**
 * actio-sync-migration の手順 (spec/feature/task-workflow-v3.md §移行手順)。
 * dry-run は計画を JSON で書き出すだけ。apply は承認済みの計画を Actio API で 1 件ずつ更新し、
 * 結果 (適用・前提崩れで飛ばした・失敗) を別ファイルへ書き出す。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { migrationOperations, operationPatch } from "../../taskflow/sync-migration-apply.js";
import { buildSyncMigrationPlan, type SyncMigrationPlan } from "../../taskflow/sync-migration-plan.js";
import { parseManualRenames } from "../../taskflow/sync-migration-renamed-codes.js";
import type { SyncMigrationArgs } from "./args.js";
import { readActioTask, readActioTasks, readCcProjects, readCcState, type HttpGet } from "./sources.js";

export interface SyncMigrationHttp {
  get: HttpGet;
  patch(url: string, body: unknown): Promise<unknown>;
}

export async function runDryRun(args: SyncMigrationArgs, http: SyncMigrationHttp, now: Date): Promise<SyncMigrationPlan> {
  const [tasks, projects] = await Promise.all([readActioTasks(http.get, args.actioUrl), readCcProjects(http.get, args.ccUrl)]);
  const { stateRows, runs } = readCcState(args.dbPath);
  const plan = buildSyncMigrationPlan({
    tasks, projects, stateRows, runs, manualRenames: parseManualRenames(args.renames), generatedAt: now.toISOString(),
  });
  writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

export async function runApply(args: SyncMigrationArgs, http: SyncMigrationHttp): Promise<{ applied: number; skipped: number; failed: number }> {
  const plan = JSON.parse(readFileSync(args.plan!, "utf8")) as SyncMigrationPlan;
  const results: Array<{ step: string; task: string; result: "applied" | "skipped" | "failed"; error?: string }> = [];
  for (const op of migrationOperations(plan, args.apply!)) {
    const id = op.task.replace(/^actio:/, "");
    try {
      const patch = operationPatch(op, await readActioTask(http.get, args.actioUrl, id));
      if (!patch) { results.push({ step: op.step, task: op.task, result: "skipped" }); continue; }
      await http.patch(`${args.actioUrl}/api/tasks/${encodeURIComponent(id)}`, patch);
      results.push({ step: op.step, task: op.task, result: "applied" });
    } catch (error) {
      results.push({ step: op.step, task: op.task, result: "failed", error: (error as Error).message });
    }
  }
  writeFileSync(args.out, `${JSON.stringify({ plan: args.plan, results }, null, 2)}\n`, "utf8");
  const count = (kind: string) => results.filter((item) => item.result === kind).length;
  return { applied: count("applied"), skipped: count("skipped"), failed: count("failed") };
}
