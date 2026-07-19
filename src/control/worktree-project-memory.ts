/**
 * Place a project's Claude memory in the corresponding linked-worktree key.
 *
 * Claude stores memory by absolute cwd under ~/.claude/projects. A linked
 * worktree therefore gets a different key even though it represents the same
 * project. Copy only that primary project's Markdown memories; workspace-wide
 * or another project's memory must never be mixed into the target Session.
 */

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("worktree-project-memory");

export interface WorktreeProjectMemoryOptions {
  homeRoot?: string;
}

export interface WorktreeProjectMemoryCopyResult {
  sourceProjectKey: string;
  targetProjectKey: string;
  copied: string[];
  preserved: string[];
}

export function claudeProjectKey(cwd: string): string {
  // Keep this byte-for-byte compatible with Lictor's cwdToProjectKey. Do not
  // call path.resolve here: a Windows cwd may be inspected by a POSIX test or
  // remote worker, and resolving it there would produce a different key.
  return cwd.trim().replace(/[:\\/]/g, "-");
}

/** Copy missing Markdown memory files without overwriting worktree-local notes. */
export async function copyWorktreeProjectMemory(
  sourceProjectRoot: string,
  targetWorktreeRoot: string,
  options: WorktreeProjectMemoryOptions = {},
): Promise<WorktreeProjectMemoryCopyResult> {
  const sourceProjectKey = claudeProjectKey(sourceProjectRoot);
  const targetProjectKey = claudeProjectKey(targetWorktreeRoot);
  const result: WorktreeProjectMemoryCopyResult = {
    sourceProjectKey,
    targetProjectKey,
    copied: [],
    preserved: [],
  };
  if (sourceProjectKey.toLowerCase() === targetProjectKey.toLowerCase()) return result;

  const home = resolve(options.homeRoot ?? homedir());
  const sourceMemoryDir = join(home, ".claude", "projects", sourceProjectKey, "memory");
  const targetMemoryDir = join(home, ".claude", "projects", targetProjectKey, "memory");
  const sourceInfo = await safeLstat(sourceMemoryDir);
  if (!sourceInfo || !sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) return result;

  const entries = await readdir(sourceMemoryDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const sourcePath = join(sourceMemoryDir, entry.name);
    const targetPath = join(targetMemoryDir, entry.name);
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      result.copied.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      result.preserved.push(entry.name);
    }
  }
  if (result.copied.length > 0) {
    log.info(
      {
        source_project_key: sourceProjectKey,
        target_project_key: targetProjectKey,
        copied: result.copied,
      },
      "worktree project memory copied",
    );
  }
  return result;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
