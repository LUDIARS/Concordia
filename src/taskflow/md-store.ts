import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import yaml from "js-yaml";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("taskflow/md-store");

export type TaskStatus = "pending" | "delegated" | "done" | "cancelled";

export interface TaskFrontmatter {
  task: string;
  project: string;
  kind: string;
  status: TaskStatus;
  created: string;
  source_session?: string;
  assignee?: string;
  owner?: string;
  delegation_run_id?: string;
  pr_number?: string | number | null;
  memoria_task_id: string | number | null;
  actio_task_id?: string | number | null;
  memory_links?: string[];
  [key: string]: unknown;
}

export interface TaskDocument {
  path: string;
  repoPath: string;
  title: string;
  frontmatter: TaskFrontmatter;
  body: string;
}

export function parseTaskMarkdown(content: string, path = "task.md"): Omit<TaskDocument, "repoPath"> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  try {
    const value = yaml.load(match[1]!) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fm = value as TaskFrontmatter;
    if (typeof fm.task !== "string" || typeof fm.project !== "string" || typeof fm.status !== "string") return null;
    const body = match[2] ?? "";
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || fm.task;
    return { path, title, frontmatter: fm, body };
  } catch (error) {
    log.warn({ path, error: (error as Error).message }, "invalid task frontmatter skipped");
    return null;
  }
}

export function renderTaskMarkdown(document: Pick<TaskDocument, "frontmatter" | "body">): string {
  return `---\n${yaml.dump(document.frontmatter, { lineWidth: -1, noRefs: true }).trimEnd()}\n---\n${document.body}`;
}

export class TaskMdStore {
  constructor(private readonly resolveRoots: () => readonly string[]) {}

  async scan(): Promise<TaskDocument[]> {
    const documents: TaskDocument[] = [];
    for (const root of this.resolveRoots()) {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const repoPath = join(root, entry.name);
        if (!existsSync(join(repoPath, ".git"))) continue;
        const tasksDir = join(repoPath, "spec", "tasks");
        let files: string[];
        try { files = (await readdir(tasksDir)).filter((name) => name.endsWith(".md")); } catch { continue; }
        for (const file of files) {
          const path = join(tasksDir, file);
          try {
            const parsed = parseTaskMarkdown(await readFile(path, "utf8"), path);
            if (parsed) documents.push({ ...parsed, repoPath });
            else log.warn({ path }, "invalid task markdown skipped");
          } catch (error) {
            log.warn({ path, error: (error as Error).message }, "task markdown read failed");
          }
        }
      }
    }
    return documents;
  }

  async updateMemoriaTaskId(document: TaskDocument, id: string | number): Promise<void> {
    const next = { ...document, frontmatter: { ...document.frontmatter, memoria_task_id: id } };
    await writeFile(document.path, renderTaskMarkdown(next), "utf8");
  }

  async findForProject(projectOrPath: string, statuses?: readonly TaskStatus[]): Promise<TaskDocument[]> {
    const needle = basename(projectOrPath.replace(/[\\/]+$/, "")).toLowerCase();
    return (await this.scan()).filter((document) => {
      const same = document.frontmatter.project.toLowerCase() === needle || basename(document.repoPath).toLowerCase() === needle;
      return same && (!statuses || statuses.includes(document.frontmatter.status));
    });
  }

  relativePath(document: TaskDocument): string {
    return relative(document.repoPath, document.path).replace(/\\/g, "/");
  }
}
