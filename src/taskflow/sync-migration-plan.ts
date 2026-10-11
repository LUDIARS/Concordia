/**
 * M1〜M6 の計画をまとめる (spec/faq/actio-cc-task-project-sync.md §5)。dry-run の出力そのもの。
 * 人が目視したこの計画だけを apply に渡す (sync-migration-apply.ts)。
 */
import { planDuplicateMerges, type DuplicateGroup } from "./sync-migration-duplicates.js";
import { planLegacyTasks, type LegacyTaskPlan } from "./sync-migration-legacy.js";
import { planMemoriaProjects, type MemoriaProjectPlan } from "./sync-migration-memoria.js";
import { planRenamedCodes, type RenamedCodePlan } from "./sync-migration-renamed-codes.js";
import { planStatusDrift } from "./sync-migration-status.js";
import { planTeamAssignments, type TeamPlan } from "./sync-migration-teams.js";
import type { MigrationActioTask, MigrationProject, MigrationRun, MigrationStateRow } from "./sync-migration-types.js";

export interface SyncMigrationInput {
  tasks: readonly MigrationActioTask[];
  projects: readonly MigrationProject[];
  stateRows: readonly MigrationStateRow[];
  runs: readonly MigrationRun[];
  manualRenames: ReadonlyMap<string, string>;
  generatedAt: string;
}

export interface SyncMigrationPlan {
  generated_at: string;
  dry_run: true;
  summary: Record<"M1" | "M2" | "M3" | "M4" | "M5" | "M6", Record<string, number>>;
  M1: DuplicateGroup[];
  M2: RenamedCodePlan;
  M3: TeamPlan;
  M4: MemoriaProjectPlan;
  M5: LegacyTaskPlan;
  M6: ReturnType<typeof planStatusDrift>;
}

export function buildSyncMigrationPlan(input: SyncMigrationInput): SyncMigrationPlan {
  const M1 = planDuplicateMerges(input.tasks, input.runs);
  const M2 = planRenamedCodes(input.tasks, input.projects, input.manualRenames);
  const M3 = planTeamAssignments(input.tasks, input.projects);
  const M4 = planMemoriaProjects(input.tasks, input.projects);
  const M5 = planLegacyTasks(input.stateRows);
  const M6 = planStatusDrift(input.stateRows, input.tasks);
  return {
    generated_at: input.generatedAt, dry_run: true,
    summary: {
      M1: { groups: M1.length, by_branch: M1.filter((group) => group.basis === "branch").length,
        review_required: M1.filter((group) => group.review_required).length,
        superseded_tasks: M1.reduce((sum, group) => sum + group.supersede.length, 0) },
      M2: { moves: M2.moves.length, unresolved: M2.unresolved.length },
      M3: { assign: M3.assign.length, choose: M3.choose.length },
      M4: { assign: M4.assign.length, unresolved: M4.unresolved.length },
      M5: { create: M5.create.length, archive: M5.archive.length },
      M6: { drift: M6.drift.length, missing_in_actio: M6.missing_in_actio.length },
    },
    M1, M2, M3, M4, M5, M6,
  };
}
