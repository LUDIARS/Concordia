import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, posix, relative, win32 } from "node:path";
import yaml from "js-yaml";
import { createChildLogger } from "../shared/logger.js";
import type { TaskflowStateStore } from "./state-store.js";
import { isTaskStatus, type TaskDocument, type TaskFrontmatter, type TaskRuntimeState, type TaskStatus } from "./types.js";

export type { TaskDocument, TaskFrontmatter, TaskRuntimeState, TaskStatus } from "./types.js";

const log = createChildLogger("taskflow/md-store");

/**
 * 失敗しても自分ではログを出さない。 周期スキャンから呼ばれるため、ここで直接
 * warn すると `TaskMdStore` の重複抑制を迂回して毎スキャン同じ行が出てしまう。
 * frontmatter の解析理由だけ `onInvalid` で呼び元へ渡し、報告可否は呼び元が決める。
 */
export function parseTaskMarkdown(
  content: string,
  path = "task.md",
  onInvalid?: (reason: string) => void,
): Omit<TaskDocument, "repoPath"> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  try {
    // JSON_SCHEMA keeps unquoted ISO dates as strings, matching TaskFrontmatter.created.
    const value = yaml.load(match[1]!, { schema: yaml.JSON_SCHEMA }) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fm = value as TaskFrontmatter;
    const created = fm.created as unknown;
    if (created instanceof Date) fm.created = created.toISOString().slice(0, 10);
    if (!nonEmptyString(fm.task) || !nonEmptyString(fm.project) || !nonEmptyString(fm.kind) || !nonEmptyString(fm.created)) return null;
    if (fm.memory_links !== undefined && (
      !Array.isArray(fm.memory_links) || fm.memory_links.some((link) => !nonEmptyString(link))
    )) return null;
    if (fm.status !== undefined && !isTaskStatus(fm.status)) {
      onInvalid?.("legacy task status is invalid");
      return null;
    }
    const body = match[2] ?? "";
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || fm.task;
    return { path, title, frontmatter: fm, body };
  } catch (error) {
    onInvalid?.((error as Error).message);
    return null;
  }
}

/**
 * 本体クローンだけを true にする。
 * 本体クローンは `.git` がディレクトリ、worktree / submodule は `.git` が
 * gitdir を指すファイルなので、これで複製側を除外できる。
 *
 * @implements spec/feature/operational-log-lifecycle.md — scan 対象の限定
 */
async function isMainClone(repoPath: string): Promise<boolean> {
  try {
    return (await stat(join(repoPath, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** md-store が使う warn だけの最小ロガー。 テストから差し替えるための境界。 */
export interface TaskMdLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export class TaskMdStore {
  /**
   * parse に失敗したパスを覚えておき、同じ失敗を毎スキャン再ログしない。
   * 周期スキャンなので、抑制しないと 1 ファイルあたり何度も warn が出る
   * (実測: 137 ファイルが平均 5.9 回ずつ、ログ量の 13% を占めていた)。
   */
  private readonly warnedPaths = new Set<string>();

  /**
   * logger は差し替え可能にしておく。 vitest は `isolate: false` で module registry を
   * 共有するので、 先に別のテストが md-store を読み込んでいると `vi.mock` が効かず
   * warn の検証ができない。 注入なら読み込み順に依存しない。
   */
  constructor(
    private readonly resolveRoots: () => readonly string[],
    private readonly logger: TaskMdLogger = log,
    private readonly state?: TaskflowStateStore,
  ) {}

  /** @implements spec/feature/operational-log-lifecycle.md — 重複 warn の抑制 */
  private warnOnce(path: string, message: string, extra?: Record<string, unknown>): void {
    if (this.warnedPaths.has(path)) return;
    this.warnedPaths.add(path);
    this.logger.warn({ path, ...extra }, message);
  }

  async scan(): Promise<TaskDocument[]> {
    const documents: TaskDocument[] = [];
    for (const root of this.resolveRoots()) {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // `.wt-*` / `.worktrees` 等の worktree・隠しディレクトリは本体クローンの
        // 複製なので、タスク md の探索対象から外す (同じ md を二重に拾い、
        // ブランチ途中の壊れた md まで拾ってしまう)。
        if (entry.name.startsWith(".")) continue;
        const repoPath = join(root, entry.name);
        if (!(await isMainClone(repoPath))) continue;
        const tasksDir = join(repoPath, "spec", "tasks");
        let files: string[];
        try {
          // A committed symlink must not let task scanning read outside spec/tasks.
          files = (await readdir(tasksDir, { withFileTypes: true }))
            .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))
            .map((candidate) => candidate.name);
        } catch { continue; }
        for (const file of files) {
          const path = join(tasksDir, file);
          let content: string;
          try {
            content = await readFile(path, "utf8");
          } catch (error) {
            this.warnOnce(path, "task markdown read failed", { error: (error as Error).message });
            continue;
          }
          const parsed = parseTaskMarkdown(content, path, (reason) =>
            this.warnOnce(path, "invalid task frontmatter skipped", { error: reason }),
          );
          if (!parsed) {
            this.warnOnce(path, "invalid task markdown skipped");
            continue;
          }
          const document = { ...parsed, repoPath };
          documents.push(this.state ? { ...document, runtime: this.state.readOrMigrate(document) } : document);
          this.warnedPaths.delete(path); // 直ったら次の失敗はまた報告する
        }
      }
    }
    return documents;
  }

  /** @implements spec/feature/task-workflow.md §2.2 — リポジトリ絶対パスと project 識別子の分離 */
  async findForProject(projectOrPath: string, statuses?: readonly TaskStatus[]): Promise<TaskDocument[]> {
    const pathSelector = isAbsoluteRepositoryPath(projectOrPath);
    const caseInsensitivePath = isWindowsAbsoluteRepositoryPath(projectOrPath);
    const needle = pathSelector
      ? normalizeRepositoryPath(projectOrPath, caseInsensitivePath)
      : repositoryBasename(projectOrPath);
    return (await this.scan()).filter((document) => {
      const same = pathSelector
        ? normalizeRepositoryPath(document.repoPath, caseInsensitivePath) === needle
        : document.frontmatter.project.trim().toLowerCase() === needle
          || repositoryBasename(document.repoPath) === needle;
      return same && (!statuses || statuses.includes(document.runtime?.status ?? "pending"));
    });
  }

  /** @implements spec/tasks/2026-09-01-goal-and-go-stale-current-task-guard.md */
  async findByRelativePath(repoPath: string, relativePath: string): Promise<{ status: string } | null> {
    if (!/^spec\/tasks\/[^/]+\.md$/.test(relativePath)) return null;
    const path = join(repoPath, relativePath);
    let content: string;
    try {
      // Match scan(): task definitions must be regular files, never symlinks outside spec/tasks.
      if (!(await lstat(path)).isFile()) return null;
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const document = parseTaskMarkdown(content, path);
    if (!document) return null;
    const status = this.state?.find({ repoPath, taskPath: relativePath })?.status
      ?? (isTaskStatus(document.frontmatter.status) ? document.frontmatter.status : "pending");
    return { status };
  }

  claimMemoriaCreation(document: TaskDocument): boolean {
    if (!this.state) throw new Error("taskflow runtime state store is required for reconciliation");
    return this.state.claimMemoriaCreation(document);
  }

  releaseMemoriaCreation(document: TaskDocument): void {
    if (!this.state) throw new Error("taskflow runtime state store is required for reconciliation");
    this.state.releaseMemoriaCreation(document);
  }

  recordMemoriaTaskId(document: TaskDocument, id: string | number): void {
    if (!this.state) throw new Error("taskflow runtime state store is required for reconciliation");
    this.state.recordMemoriaTaskId(document, id);
  }

  relativePath(document: TaskDocument): string {
    return relative(document.repoPath, document.path).replace(/\\/g, "/");
  }

  async writeRemainingTasks(input: {
    repoPath: string;
    sourceRunId: string;
    project: string;
    remaining: ReadonlyArray<{ title: string; note?: string; scope_dirs?: string[] }>;
  }): Promise<string[]> {
    const dir = join(input.repoPath, "spec", "tasks");
    await mkdir(dir, { recursive: true });
    const created: string[] = [];
    const sourceSlug = taskSlug(input.sourceRunId, "run", 48);
    const createdDate = new Date().toISOString().slice(0, 10);
    for (const [index, item] of input.remaining.entries()) {
      const slug = taskSlug(item.title, `remaining-${index + 1}`, 60);
      const path = join(dir, `${createdDate}-${sourceSlug}-${index + 1}-${slug}.md`);
      const markdown = renderRemainingTask({
        item,
        slug,
        project: input.project,
        sourceRunId: input.sourceRunId,
        repoPath: input.repoPath,
        createdDate,
      });
      await writeFile(path, markdown, { encoding: "utf8", flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      created.push(path);
    }
    return created;
  }
}

function isAbsoluteRepositoryPath(value: string): boolean {
  const trimmed = value.trim();
  return win32.isAbsolute(trimmed) || posix.isAbsolute(trimmed);
}

function isWindowsAbsoluteRepositoryPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(trimmed)
    || /^\\/.test(trimmed)
    || /^\/\/[^/\\]+[/\\][^/\\]+/.test(trimmed);
}

function normalizeRepositoryPath(value: string, caseInsensitive = false): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = (caseInsensitive
    ? win32.normalize(trimmed).replace(/\\/g, "/")
    : posix.normalize(trimmed.replace(/\\/g, "/")))
    .replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function repositoryBasename(value: string): string {
  const normalized = normalizeRepositoryPath(value).toLowerCase();
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? "";
}

function taskSlug(value: string, fallback: string, maxLength: number): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength) || fallback;
}

function renderRemainingTask(input: {
  item: { title: string; note?: string; scope_dirs?: string[] };
  slug: string;
  project: string;
  sourceRunId: string;
  repoPath: string;
  createdDate: string;
}): string {
  return [
    "---",
    `task: ${JSON.stringify(input.slug)}`,
    `project: ${JSON.stringify(input.project)}`,
    `kind: ${JSON.stringify("実装")}`,
    `created: ${JSON.stringify(input.createdDate)}`,
    "---",
    `# ${input.item.title}`,
    "",
    "## 目的",
    input.item.note?.trim() || `delegation run ${input.sourceRunId} の残作業を完了する。`,
    "",
    "## 完了条件",
    `- ${input.item.title} が完了している。`,
    "",
    "## スコープ (編集可ディレクトリ)",
    ...(input.item.scope_dirs?.map((scope) => `- ${scope}`) ?? [`- ${input.repoPath}`]),
    "",
  ].join("\n");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
