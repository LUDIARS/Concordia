import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface ProjectCategory {
  name: string;
  entries: Array<[code: string, project: string]>;
}

export interface ProjectCodesDocument {
  sourcePath: string;
  categories: ProjectCategory[];
}

/** Parse the canonical Markdown table without duplicating project data in code. */
export function parseProjectCodes(markdown: string): ProjectCategory[] {
  const categories: ProjectCategory[] = [];
  let current: ProjectCategory | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1] === "運用ルール" ? null : { name: heading[1], entries: [] };
      if (current) categories.push(current);
      continue;
    }
    if (!current || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells[0] === "Code" || /^-+$/.test(cells[0])) continue;
    const link = cells[1].match(/^\[([^\]]+)]\([^)]+\)$/);
    const project = (link?.[1] ?? cells[1]).trim();
    const code = cells[0].replace(/\s*\/\s*/g, "/");
    if (code && project) current.entries.push([code, project]);
  }

  return categories.filter((category) => category.entries.length > 0);
}

export function resolveProjectCodesPath(workspaceRoots: readonly string[]): string {
  for (const root of workspaceRoots) {
    const candidates = [
      join(root, "LUDIARS", "PROJECT-CODES.md"),
      ...(basename(root).toLowerCase() === "ludiars" ? [join(root, "PROJECT-CODES.md")] : []),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("LUDIARS/PROJECT-CODES.md was not found under any configured workspace root");
}

export function loadProjectCodes(workspaceRoots: readonly string[]): ProjectCodesDocument {
  const sourcePath = resolveProjectCodesPath(workspaceRoots);
  return {
    sourcePath,
    categories: parseProjectCodes(readFileSync(sourcePath, "utf8")),
  };
}
