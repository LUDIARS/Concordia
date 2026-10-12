/**
 * M5 で Actio に作る中身を旧 md から読む。題名は委託と同じ規則 (CC-TF-SYNC-04、delegation/task-title.ts) で
 * md の見出し (無ければ frontmatter の task、本文の 1 行目) から決める。種別と記憶リンクは frontmatter を引き継ぐ。
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deriveTaskTitle } from "../../delegation/task-title.js";
import { parseTaskMarkdown } from "../../taskflow/md-store.js";
import type { LegacyTaskContent } from "../../taskflow/sync-migration-legacy-describe.js";

export function legacyTaskContent(content: string, taskPath: string): LegacyTaskContent {
  const document = parseTaskMarkdown(content, taskPath);
  // frontmatter が今の検証に通らない古い md でも、frontmatter を本文や題名に混ぜない。
  const body = document?.body ?? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const fallback = basename(taskPath, ".md");
  const links = document?.frontmatter.memory_links;
  return {
    title: deriveTaskTitle({ args: document?.title ? { task: document.title } : {}, content: body, fallback }),
    body,
    kind: typeof document?.frontmatter.kind === "string" && document.frontmatter.kind.trim() ? document.frontmatter.kind.trim() : "実装",
    memoryLinks: Array.isArray(links) ? links.filter((link): link is string => typeof link === "string") : [],
  };
}

/** md が読めなければ null (移した後に消えた・別の checkout にある)。 */
export function readLegacyTaskContent(repoPath: string, taskPath: string): LegacyTaskContent | null {
  try { return legacyTaskContent(readFileSync(join(repoPath, taskPath), "utf8"), taskPath); }
  catch { return null; }
}
