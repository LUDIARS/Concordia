/**
 * M5 の I/O の境界と、適用時の ports の組み立て (taskflow/sync-migration-legacy-apply.ts)。
 * 適用の直前に binding を読み直し、計画時の作り先 (プロジェクト・チーム) から変わっていれば作らない。
 */
import type { ActioBinding } from "../../taskflow/actio-binding.js";
import type { LegacyApplyPorts } from "../../taskflow/sync-migration-legacy-apply.js";
import { bindingForRepo, type LegacyTaskContent } from "../../taskflow/sync-migration-legacy-describe.js";
import type { LegacyCreatePlan } from "../../taskflow/sync-migration-legacy.js";
import type { MigrationProject, MigrationStateRow } from "../../taskflow/sync-migration-types.js";
import type { LegacyStateAccess } from "./legacy-state.js";

export interface LegacyMigrationIo {
  commitTimes(rows: readonly MigrationStateRow[]): ReadonlyMap<string, number>;
  bindings(projects: readonly MigrationProject[]): Promise<readonly ActioBinding[]>;
  readContent(repoPath: string, taskPath: string): LegacyTaskContent | null;
  createTask(binding: ActioBinding, entry: LegacyCreatePlan, content: LegacyTaskContent): Promise<{ id: string; existed: boolean }>;
  openState(dbPath: string): LegacyStateAccess;
}

export function legacyApplyPorts(io: LegacyMigrationIo, bindings: readonly ActioBinding[], state: LegacyStateAccess): LegacyApplyPorts {
  return {
    currentRow: state.currentRow,
    replaceTaskPath: state.replaceTaskPath,
    async createTask(entry) {
      const resolved = bindingForRepo(bindings, entry.repo_path, entry.subsidiary_id);
      if (!resolved.ok) return { skip: resolved.reason };
      if (resolved.binding.projectId !== entry.project || resolved.binding.teamId !== (entry.team ?? null)) return { skip: "binding_changed" };
      const content = io.readContent(entry.repo_path, entry.task_path);
      if (!content) return { skip: "md_missing" };
      return io.createTask(resolved.binding, entry, content);
    },
  };
}
