/**
 * 移行計画の入力を読む adapter。Actio と Cc は HTTP の GET、Cc の DB は readonly で開く。
 * ここでは何も書き込まない。
 */
import Database from "better-sqlite3";
import { z } from "zod";
import type { MigrationActioTask, MigrationProject, MigrationRun, MigrationStateRow } from "../../taskflow/sync-migration-types.js";

const Task = z.object({
  id: z.string(), title: z.string(), description: z.string().nullable(),
  projectId: z.string().nullable(), teamId: z.string().nullable(),
  status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
  source: z.string().nullable(), category: z.string().nullable().optional(),
  pluginPayload: z.record(z.unknown()).nullable().optional(), createdAt: z.string(),
  ownerId: z.string().optional(), assigneeId: z.string().nullable().optional(),
}).passthrough();

const Project = z.object({
  code: z.string(), project: z.string(),
  teams: z.array(z.object({ id: z.string() })).default([]),
  renamed_from: z.array(z.string()).default([]),
  repo_path: z.string().nullable().optional(),
});

export type HttpGet = (url: string) => Promise<unknown>;
export type ActioTaskWithOwner = z.infer<typeof Task>;

export async function readActioTasks(get: HttpGet, actioUrl: string): Promise<MigrationActioTask[]> {
  return z.object({ tasks: z.array(Task) }).parse(await get(`${actioUrl}/api/tasks?scope=all`)).tasks;
}

export async function readActioTask(get: HttpGet, actioUrl: string, id: string): Promise<ActioTaskWithOwner> {
  return z.object({ task: Task }).parse(await get(`${actioUrl}/api/tasks/${encodeURIComponent(id)}`)).task;
}

export async function readCcProjects(get: HttpGet, ccUrl: string): Promise<MigrationProject[]> {
  const entries = z.object({ entries: z.array(Project) }).parse(await get(`${ccUrl}/v1/project-codes/admin`)).entries;
  return entries.map((entry) => ({ code: entry.code, project: entry.project,
    teams: entry.teams.map((team) => team.id), renamed_from: entry.renamed_from, repo_path: entry.repo_path ?? null }));
}

export function readCcState(dbPath: string): { stateRows: MigrationStateRow[]; runs: MigrationRun[] } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const stateRows = db.prepare(`SELECT repo_path, task_path, status, actio_task_id, delegation_run_id, updated_at, subsidiary_id
      FROM taskflow_task_state`).all() as MigrationStateRow[];
    const runs = (db.prepare(`SELECT id, args_json, spawn_branch, created_at FROM delegation_runs
      WHERE args_json LIKE '%taskflow_reference%'`).all() as Array<{ id: string; args_json: string; spawn_branch: string | null; created_at: number }>)
      .map((row) => {
        let reference: string | null = null;
        try {
          const args = JSON.parse(row.args_json) as Record<string, unknown>;
          reference = typeof args.taskflow_reference === "string" ? args.taskflow_reference : null;
        } catch { reference = null; }
        return { id: row.id, reference, branch: row.spawn_branch, createdAt: row.created_at };
      });
    return { stateRows, runs };
  } finally { db.close(); }
}
