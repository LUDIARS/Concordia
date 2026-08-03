import { readdir, readFile, stat, writeFile } from "node:fs/promises";
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
    const value = yaml.load(match[1]!) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fm = value as TaskFrontmatter;
    if (typeof fm.task !== "string" || typeof fm.project !== "string" || typeof fm.status !== "string") return null;
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

export function renderTaskMarkdown(document: Pick<TaskDocument, "frontmatter" | "body">): string {
  return `---\n${yaml.dump(document.frontmatter, { lineWidth: -1, noRefs: true }).trimEnd()}\n---\n${document.body}`;
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
        try { files = (await readdir(tasksDir)).filter((name) => name.endsWith(".md")); } catch { continue; }
        for (const file of files) {
          const path = join(tasksDir, file);
          try {
            const parsed = parseTaskMarkdown(await readFile(path, "utf8"), path, (reason) =>
              this.warnOnce(path, "invalid task frontmatter skipped", { error: reason }),
            );
            if (parsed) {
              documents.push({ ...parsed, repoPath });
              this.warnedPaths.delete(path); // 直ったら次の失敗はまた報告する
            } else {
              this.warnOnce(path, "invalid task markdown skipped");
            }
          } catch (error) {
            this.warnOnce(path, "task markdown read failed", { error: (error as Error).message });
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
