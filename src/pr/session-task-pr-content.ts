/**
 * セッションに紐づく task md を Revisor 提出用の PR 内容へ写す。
 *
 * task md は設計の正本であり、該当タスクがあれば提出内容へ写す。該当タスクが無い、
 * または完了条件が空の場合は空セクションを返す。日本語・文字数を含む最終的な内容契約は
 * 提出側が検証し、不適合ならコミット件名フォールバックを選ぶ。
 *
 * @implements spec/feature/revisor-local-pr-submission.md §4
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskMarkdown, type TaskDocument } from "../taskflow/md-store.js";

const MAX_PR_TITLE_LENGTH = 200;

export interface SessionTaskPrContent {
  title: string;
  body: string;
}

/** worktree 上の task md を読む。TaskMdStore は本体 clone だけを走査するため使わない。 */
export async function loadSessionTaskPrContent(
  repoPath: string,
  sessionId: string,
): Promise<SessionTaskPrContent> {
  const tasksDir = join(repoPath, "spec", "tasks");
  let entries: Dirent[];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return emptyContent();
  }

  // A committed symlink could otherwise make PR generation copy a task-shaped
  // file from outside the repository into Revisor.
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const documents = await Promise.all(names.map(async (name) => {
    const path = join(tasksDir, name);
    try {
      const parsed = parseTaskMarkdown(await readFile(path, "utf8"), path);
      return parsed ? { ...parsed, repoPath } : null;
    } catch {
      return null;
    }
  }));
  return buildSessionTaskPrContent(
    documents.filter((document): document is TaskDocument => document !== null),
    sessionId,
  );
}

export function buildSessionTaskPrContent(
  documents: readonly TaskDocument[],
  sessionId: string,
): SessionTaskPrContent {
  const tasks = documents.filter((document) => {
    const sourceSession = document.frontmatter.source_session;
    return typeof sourceSession === "string" && sourceSession.trim() === sessionId;
  });
  if (tasks.length === 0) return emptyContent();

  const title = tasks.length === 1
    ? tasks[0]!.title.slice(0, MAX_PR_TITLE_LENGTH)
    : `複数タスクを実装: ${tasks.map((task) => task.title).join(" / ")}`.slice(0, MAX_PR_TITLE_LENGTH);
  const implementation = tasks.map((task) => sectionForTask(task, withoutAcceptance(task.body))).join("\n\n");
  const acceptanceSections = tasks.map((task) => sectionForTask(
    task,
    findSections(task.body, ["完了条件", "受け入れ条件"]),
  ));
  // 複数タスクを同じ PR で出す場合も、どれか一つの条件を省略して他の条件で
  // 通過させない。空にして提出側の契約準拠フォールバックを選ばせる。
  const acceptance = acceptanceSections.every((section) => section.trim())
    ? acceptanceSections.join("\n\n")
    : "";

  return {
    title,
    body: [
      "## 実装内容",
      implementation,
      "",
      "## 受け入れ条件",
      acceptance,
    ].join("\n").trimEnd(),
  };
}

function emptyContent(): SessionTaskPrContent {
  return {
    title: "PR 内容未登録",
    body: "## 実装内容\n\n## 受け入れ条件",
  };
}

function sectionForTask(task: TaskDocument, content: string): string {
  return content.trim() ? `### ${task.title}\n${content.trim()}` : "";
}

function withoutAcceptance(markdown: string): string {
  // parseTaskMarkdown accepts the first H1 even when blank lines precede it;
  // remove that same title before adding the per-task H3 wrapper.
  const withoutTitle = markdown.replace(/^#\s+.+(?:\r?\n|$)/m, "").trim();
  const sections = findSectionRanges(withoutTitle, ["完了条件", "受け入れ条件"]);
  if (sections.length === 0) return withoutTitle;

  const lines = withoutTitle.split(/\r?\n/);
  const kept: string[] = [];
  let cursor = 0;
  for (const section of sections) {
    kept.push(...lines.slice(cursor, section.heading));
    cursor = section.end;
  }
  kept.push(...lines.slice(cursor));
  return kept.join("\n").trim();
}

function findSections(markdown: string, names: readonly string[]): string {
  const lines = markdown.split(/\r?\n/);
  return findSectionRanges(markdown, names)
    .map((range) => lines.slice(range.start, range.end).join("\n").trim())
    .filter((section) => section.length > 0)
    .join("\n\n");
}

interface MarkdownSectionRange {
  heading: number;
  start: number;
  end: number;
}

function findSectionRanges(markdown: string, names: readonly string[]): MarkdownSectionRange[] {
  const lines = markdown.split(/\r?\n/);
  const ranges: MarkdownSectionRange[] = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(lines[index]!);
    if (!heading || !names.includes(heading[2]!)) continue;
    const level = heading[1]!.length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = /^(#{2,6})\s+/.exec(lines[cursor]!);
      if (next && next[1]!.length <= level) {
        end = cursor;
        break;
      }
    }
    ranges.push({ heading: index, start: index + 1, end });
    // A matched section owns nested headings, so do not extract a nested alias
    // again and duplicate its content in the acceptance section.
    index = end - 1;
  }
  return ranges;
}
