/**
 * Copy ignored project-local agent configuration into a linked worktree.
 *
 * Git materializes tracked files by itself, but trust, hook, skill, and MCP
 * configuration commonly lives in ignored project directories. A new
 * worktree must inherit those files before Lictor starts or the provider may
 * show a first-run trust dialog.
 */

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("worktree-project-config");

const PROJECT_CONFIG_DIRECTORIES = [".claude", ".agent", ".agents", ".codex"] as const;
const PROJECT_CONFIG_FILES = [".mcp.json", "mcp.json", "mcp_servers.json"] as const;
const RUNTIME_DIRECTORY_NAMES = new Set([
  "cache",
  "logs",
  "memory",
  "sessions",
  "state",
  "temp",
  "tmp",
  "worktrees",
]);

export interface WorktreeProjectConfigCopyResult {
  copied: string[];
  preserved: string[];
}

/**
 * Copy only missing files. Existing worktree-local configuration is preserved,
 * and symlinks are skipped so the copy cannot escape either project root.
 */
export async function copyWorktreeProjectConfig(
  sourceRoot: string,
  targetRoot: string,
): Promise<WorktreeProjectConfigCopyResult> {
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  if (samePath(source, target)) return { copied: [], preserved: [] };

  const result: WorktreeProjectConfigCopyResult = { copied: [], preserved: [] };
  for (const directory of PROJECT_CONFIG_DIRECTORIES) {
    await copyEntry(source, target, directory, result);
  }
  for (const file of PROJECT_CONFIG_FILES) {
    await copyEntry(source, target, file, result);
  }
  if (result.copied.length > 0) {
    log.info(
      { source_root: source, target_root: target, copied: result.copied },
      "worktree project configuration copied",
    );
  }
  return result;
}

async function copyEntry(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
  result: WorktreeProjectConfigCopyResult,
): Promise<void> {
  const sourcePath = join(sourceRoot, relativePath);
  const info = await safeLstat(sourcePath);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    if (isTopLevelRuntimeDirectory(relativePath)) return;
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      await copyEntry(sourceRoot, targetRoot, join(relativePath, entry.name), result);
    }
    return;
  }
  if (!info.isFile()) return;

  const targetPath = join(targetRoot, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    result.copied.push(slash(relative(sourceRoot, sourcePath)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    result.preserved.push(slash(relative(targetRoot, targetPath)));
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function isTopLevelRuntimeDirectory(relativePath: string): boolean {
  const parts = slash(relativePath).split("/");
  return parts.length === 2 && RUNTIME_DIRECTORY_NAMES.has(parts[1].toLowerCase());
}
