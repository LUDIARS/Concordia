import { existsSync } from "node:fs";

import {
  dedupeWorkspaceRoots,
  readConfiguredWorkspaceRoots,
} from "../config/workspace-roots.js";

/**
 * Recover a Windows project path only when a transport has removed every
 * separator and the result maps unambiguously to a direct workspace child.
 *
 * The normal path is returned untouched. Recovery is deliberately narrow:
 * ambiguous nested paths must remain invalid rather than guessing a cwd.
 */
export function recoverCollapsedWindowsWorkspacePath(
  value: string,
  workspaceRoots: readonly string[] = configuredWorkspaceRoots(),
  exists: (path: string) => boolean = existsSync,
): string {
  const raw = value.trim();
  if (!/^[A-Za-z]:[^\\/]/.test(raw)) return raw;

  for (const workspaceRoot of workspaceRoots) {
    const root = workspaceRoot.trim().replace(/[\\/]+$/, "");
    if (!root) continue;
    const compactRoot = root.replace(/[\\/]/g, "");
    if (raw.toLowerCase() === compactRoot.toLowerCase() && exists(root)) return root;
    if (!raw.toLowerCase().startsWith(compactRoot.toLowerCase())) continue;

    const child = raw.slice(compactRoot.length);
    if (!/^[A-Za-z0-9._ -]+$/.test(child)) continue;

    const candidate = `${root}\\${child}`;
    if (exists(candidate)) return candidate;
  }

  return raw;
}

/**
 * env 由来のルートに加え、 起動時 cwd も復元候補に含める
 * (Concordia 自身のチェックアウト親から辿るケースがあるため)。
 */
function configuredWorkspaceRoots(): string[] {
  return dedupeWorkspaceRoots([...readConfiguredWorkspaceRoots(), process.cwd()]);
}
