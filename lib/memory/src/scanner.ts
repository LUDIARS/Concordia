/**
 * roots を歩いて メモリ home / スキル root を発見し、 block を読み出す。
 *
 * - メモリ home: `<claudeProjectsDir>/<slug>/memory` (MEMORY.md を持つ dir)
 * - グローバルスキル: `<arsDir>/.claude/skills`
 * - プロジェクトスキル: `<arsDir>/<repo>/.claude/skills`
 *
 * 退避先 `_archive/` と隠し/アンダースコア dir は走査対象から除く。
 * flags / findings は付けない (それは review.ts の責務)。
 */

import { readdirSync, readFileSync, statSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { LibraryRoots } from "./roots.js";
import type { LibraryBlock, LibrarySource } from "./types.js";
import { parseMemoryIndex, parseFrontmatter, type IndexEntry } from "./parser.js";
import { scanPoison } from "./heuristics.js";

const MEMORY_INDEX = "MEMORY.md";
export const ARCHIVE_DIRNAME = "_archive";

interface FileStat {
  size: number;
  mtime: number;
  lines: number;
  content: string;
}

function readFileStat(abs: string): FileStat | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let content = "";
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  return {
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
    lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    content,
  };
}

function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** メモリ home を発見する (MEMORY.md を持つ `<projects>/<slug>/memory`)。 */
export function scanMemorySources(roots: LibraryRoots): LibrarySource[] {
  const out: LibrarySource[] = [];
  const slugs = listDirs(roots.claudeProjectsDir);
  for (const slug of slugs) {
    const memoryDir = join(roots.claudeProjectsDir, slug, "memory");
    const indexPath = join(memoryDir, MEMORY_INDEX);
    if (!existsSync(indexPath)) continue;
    const central = slug === roots.centralSlug;
    out.push(buildMemorySource(slug, memoryDir, indexPath, central));
  }
  // central を先頭に。
  out.sort((a, b) => (a.sourceKind === "central-memory" ? -1 : b.sourceKind === "central-memory" ? 1 : a.label.localeCompare(b.label)));
  return out;
}

function buildMemorySource(
  slug: string,
  memoryDir: string,
  indexPath: string,
  central: boolean,
): LibrarySource {
  const indexStat = readFileStat(indexPath);
  const indexEntries: IndexEntry[] = indexStat ? parseMemoryIndex(indexStat.content) : [];
  const entryByFile = new Map<string, IndexEntry>();
  for (const e of indexEntries) entryByFile.set(e.fileName, e);

  const sourceId = `mem:${slug}`;
  const blocks: LibraryBlock[] = [];
  const seenFiles = new Set<string>();

  // 実ファイル (memory/*.md、 MEMORY.md と _archive は除く)。
  let names: string[] = [];
  try {
    names = readdirSync(memoryDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md") && d.name !== MEMORY_INDEX)
      .map((d) => d.name);
  } catch {
    names = [];
  }
  for (const fileName of names) {
    const st = readFileStat(join(memoryDir, fileName));
    if (!st) continue;
    seenFiles.add(fileName);
    const fm = parseFrontmatter(st.content);
    const entry = entryByFile.get(fileName);
    const poison = scanPoison(st.content);
    blocks.push({
      id: `${sourceId}::${fileName}`,
      sourceId,
      kind: "memory",
      name: fileName,
      title: entry?.title || fm.name || fileName.replace(/\.md$/, ""),
      description: fm.description || entry?.hook || "",
      relPath: fileName,
      size_bytes: st.size,
      line_count: st.lines,
      mtime: st.mtime,
      flags: poison.length > 0 ? { poison } : {},
      indexLine: entry?.raw,
      indexLinkText: entry?.linkText,
      indexLineSole: entry?.sole,
    });
  }

  // index にあるが実ファイルが無い (orphan-index)。 退避 = index 行/リンクのみ除去。
  // パスリンク (例 `../skills/.../SKILL.md`) は兄弟メモリファイルではないので対象外。
  const seenOrphan = new Set<string>();
  for (const e of indexEntries) {
    if (seenFiles.has(e.fileName)) continue;
    if (e.link.includes("/")) continue;
    if (seenOrphan.has(e.fileName)) continue;
    seenOrphan.add(e.fileName);
    blocks.push({
      id: `${sourceId}::${e.fileName}`,
      sourceId,
      kind: "memory",
      name: e.fileName,
      title: e.title,
      description: e.hook,
      relPath: e.fileName,
      size_bytes: 0,
      line_count: 0,
      mtime: 0,
      flags: { orphanIndex: true },
      indexLine: e.raw,
      indexLinkText: e.linkText,
      indexLineSole: e.sole,
    });
  }

  return {
    id: sourceId,
    kind: "memory",
    sourceKind: central ? "central-memory" : "project-memory",
    label: central ? `${slug} (central)` : slug,
    rootDir: memoryDir,
    indexPath,
    indexLineCount: indexStat ? indexStat.lines : 0,
    indexBytes: indexStat ? indexStat.size : 0,
    blocks,
  };
}

/** スキル root を発見する (グローバル + 各リポ)。 */
export function scanSkillSources(roots: LibraryRoots): LibrarySource[] {
  const out: LibrarySource[] = [];
  if (roots.arsDir) {
    const globalSkills = join(roots.arsDir, ".claude", "skills");
    if (existsSync(globalSkills)) {
      out.push(buildSkillSource("skill:global", "global", "global-skill", globalSkills));
    }
    for (const repo of listDirs(roots.arsDir)) {
      const repoSkills = join(roots.arsDir, repo, ".claude", "skills");
      if (existsSync(repoSkills)) {
        out.push(buildSkillSource(`skill:${repo}`, repo, "project-skill", repoSkills));
      }
    }
  }
  return out;
}

function buildSkillSource(
  sourceId: string,
  label: string,
  sourceKind: "global-skill" | "project-skill",
  skillsDir: string,
): LibrarySource {
  const blocks: LibraryBlock[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      pushSkillBlock(blocks, sourceId, skillsDir, ent.name, ent.name, join(skillsDir, ent.name));
    } else if (ent.isDirectory()) {
      const skillMd = join(skillsDir, ent.name, "SKILL.md");
      if (existsSync(skillMd)) {
        pushSkillBlock(blocks, sourceId, skillsDir, ent.name, ent.name, skillMd);
      }
    }
  }
  blocks.sort((a, b) => a.name.localeCompare(b.name));
  return { id: sourceId, kind: "skill", sourceKind, label, rootDir: skillsDir, blocks };
}

function pushSkillBlock(
  blocks: LibraryBlock[],
  sourceId: string,
  skillsDir: string,
  name: string,
  relPath: string,
  contentAbs: string,
): void {
  const st = readFileStat(contentAbs);
  if (!st) return;
  const fm = parseFrontmatter(st.content);
  const cleanName = name.replace(/\.md$/, "");
  const poison = scanPoison(st.content);
  blocks.push({
    id: `${sourceId}::${name}`,
    sourceId,
    kind: "skill",
    name,
    title: fm.name || cleanName,
    description: fm.description || "",
    relPath,
    size_bytes: st.size,
    line_count: st.lines,
    mtime: st.mtime,
    flags: poison.length > 0 ? { poison } : {},
  });
}

/** メモリ + スキルの全 source を発見する。 */
export function scanLibrary(roots: LibraryRoots): LibrarySource[] {
  return [...scanMemorySources(roots), ...scanSkillSources(roots)];
}
