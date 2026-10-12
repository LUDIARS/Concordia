/**
 * actio-sync-migration の手順 (spec/feature/task-workflow-v3.md §移行手順)。
 * dry-run は計画を JSON で書き出すだけ。apply は承認済みの計画を Actio API で 1 件ずつ更新し、
 * 結果 (適用・前提崩れで飛ばした・失敗) を別ファイルへ書き出す。
 * M5 は Actio への作成と Cc の状態行の参照置換を伴うので、I/O を LegacyMigrationIo として受け取る。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { migrationOperations, operationPatch } from "../../taskflow/sync-migration-apply.js";
import { applyLegacyPlan, type LegacyApplyResult } from "../../taskflow/sync-migration-legacy-apply.js";
import { describeLegacyPlan } from "../../taskflow/sync-migration-legacy-describe.js";
import { buildSyncMigrationPlan, type SyncMigrationPlan } from "../../taskflow/sync-migration-plan.js";
import { parseManualRenames } from "../../taskflow/sync-migration-renamed-codes.js";
import type { SyncMigrationArgs } from "./args.js";
import { legacyApplyPorts, type LegacyMigrationIo } from "./legacy-ports.js";
import { readActioTask, readActioTasks, readCcProjects, readCcState, type HttpGet } from "./sources.js";

export interface SyncMigrationHttp {
  get: HttpGet;
  patch(url: string, body: unknown): Promise<unknown>;
}

export async function runDryRun(
  args: SyncMigrationArgs, http: SyncMigrationHttp, now: Date, legacy: LegacyMigrationIo,
): Promise<SyncMigrationPlan> {
  const [tasks, projects] = await Promise.all([readActioTasks(http.get, args.actioUrl), readCcProjects(http.get, args.ccUrl)]);
  const { stateRows, runs } = readCcState(args.dbPath);
  const bindings = await legacy.bindings(projects);
  const plan = buildSyncMigrationPlan({
    tasks, projects, stateRows, runs, manualRenames: parseManualRenames(args.renames), generatedAt: now.toISOString(),
    legacy: { recentDays: args.legacyRecentDays, commitTimes: legacy.commitTimes(stateRows),
      describe: (planned) => describeLegacyPlan(planned, bindings, legacy.readContent) },
  });
  writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

async function applyLegacy(
  args: SyncMigrationArgs, http: SyncMigrationHttp, plan: SyncMigrationPlan, legacy: LegacyMigrationIo,
): Promise<LegacyApplyResult[]> {
  const bindings = await legacy.bindings(await readCcProjects(http.get, args.ccUrl));
  const state = legacy.openState(args.dbPath);
  try { return await applyLegacyPlan(plan.M5, legacyApplyPorts(legacy, bindings, state)); }
  finally { state.close(); }
}

export async function runApply(
  args: SyncMigrationArgs, http: SyncMigrationHttp, legacy: LegacyMigrationIo,
): Promise<{ applied: number; skipped: number; failed: number }> {
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
  if (args.apply!.has("M5")) results.push(...await applyLegacy(args, http, plan, legacy));
  writeFileSync(args.out, `${JSON.stringify({ plan: args.plan, results }, null, 2)}\n`, "utf8");
  const count = (kind: string) => results.filter((item) => item.result === kind).length;
  return { applied: count("applied"), skipped: count("skipped"), failed: count("failed") };
}
