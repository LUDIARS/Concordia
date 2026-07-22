import type { SettingsStore } from "./settings-store.js";

const ROOT = "admin.workspace_root";
const ROOTS = "admin.workspace_roots";
const GITHUB_ORG = "admin.github_org";

export interface WorkspaceSettingsDefaults {
  workspaceRoot?: string;
  workspaceRoots?: string[];
  githubOrg?: string;
}

export class WorkspaceSettingsStore {
  constructor(private readonly store: SettingsStore, private readonly defaults: WorkspaceSettingsDefaults) {}

  getRoots(): string[] {
    const array = this.store.get(ROOTS);
    if (array !== null) {
      const roots = cleanRoots(parseRoots(array));
      if (roots.length > 0) return roots;
    }
    const legacy = this.store.get(ROOT)?.trim();
    if (legacy) return [legacy];
    return cleanRoots(this.defaults.workspaceRoots ?? (this.defaults.workspaceRoot ? [this.defaults.workspaceRoot] : []));
  }

  getPrimaryRoot(): string { return this.getRoots()[0] ?? ""; }
  setRoots(roots: string[]): void { this.store.set(ROOTS, JSON.stringify(cleanRoots(roots))); }
  setPrimaryRoot(root: string): void { this.setRoots(root.trim() ? [root.trim()] : []); }

  getGithubOrg(): string {
    return this.store.get(GITHUB_ORG)?.trim() || this.defaults.githubOrg || "";
  }
  setGithubOrg(org: string): void { this.store.set(GITHUB_ORG, org.trim()); }
}

function parseRoots(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

function cleanRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  return roots.map((root) => root.trim()).filter((root) => {
    if (!root) return false;
    const key = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
