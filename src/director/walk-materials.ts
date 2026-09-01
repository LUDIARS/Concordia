/**
 * 散歩セッションの素材集めとサンプリング (spec/feature/curiosity-walk.md §1)。
 *
 * 素材源 (読むだけ): 各リポの spec/feature・spec/tasks の md / 直近マージ PR /
 * director case の goal。 2 件は「別リポであること」を第一の遠さとしてサンプリングし、
 * 直近に出した組み合わせ種類 (combo key) を避ける。
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { walkComboKey } from "../db/walks-repo.js";

export interface WalkMaterial {
  /** リポジトリ名 (ローカル clone のディレクトリ名)。遠さ判定の単位。 */
  repo: string;
  kind: "spec" | "task" | "pr" | "case";
  /** 1 行ラベル (プロンプトへ載せる)。 */
  label: string;
  /** 参照先 (ファイルパス / PR 番号など)。セッションが読みに行く手掛かり。 */
  detail: string;
}

export interface WalkMaterialsDeps {
  workspaceRoots: readonly string[];
  /** 直近マージされた GitHub PR (pr_records)。省略可。 */
  recentlyMergedPrs?: () => Array<{ repo_origin: string; number: number; title: string }>;
  /** Director case の goal。省略可。 */
  directorCases?: () => Array<{ project: string; title: string; goal: string }>;
  /** 1 リポあたりの spec/task 素材上限 (既定 6)。 */
  maxPerRepo?: number;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "logs", "reviews", ".git", ".worktrees"]);

async function listMd(dir: string, limit: number): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** workspace 直下の各リポから素材を集める。 I/O 失敗はそのリポを飛ばすだけ。 */
export async function collectWalkMaterials(deps: WalkMaterialsDeps): Promise<WalkMaterial[]> {
  const maxPerRepo = deps.maxPerRepo ?? 6;
  const materials: WalkMaterial[] = [];

  for (const root of deps.workspaceRoots) {
    let repos: string[] = [];
    try {
      repos = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const repo of repos) {
      const specs = await listMd(join(root, repo, "spec", "feature"), maxPerRepo);
      for (const name of specs) {
        materials.push({ repo, kind: "spec", label: `${repo} spec/feature/${name}`, detail: join(root, repo, "spec", "feature", name) });
      }
      const remaining = maxPerRepo - specs.length;
      if (remaining > 0) {
        for (const name of await listMd(join(root, repo, "spec", "tasks"), remaining)) {
          materials.push({ repo, kind: "task", label: `${repo} spec/tasks/${name}`, detail: join(root, repo, "spec", "tasks", name) });
        }
      }
    }
  }

  for (const pr of deps.recentlyMergedPrs?.() ?? []) {
    const repo = pr.repo_origin.split("/").pop() || pr.repo_origin;
    materials.push({ repo, kind: "pr", label: `${pr.repo_origin}#${pr.number} ${pr.title}`, detail: `merged PR ${pr.repo_origin}#${pr.number}` });
  }
  for (const c of deps.directorCases?.() ?? []) {
    if (!c.project) continue;
    materials.push({ repo: c.project, kind: "case", label: `case「${c.title}」`, detail: `goal: ${c.goal.slice(0, 300)}` });
  }
  return materials;
}

export interface WalkPair {
  a: WalkMaterial;
  b: WalkMaterial;
  comboKey: string;
}

export interface SampleWalkPairOpts {
  /** チームの repo 群 (origin 形式可)。 あれば片方をここへ寄せる。 */
  biasRepos?: readonly string[];
  /** 直近に出した組み合わせ種類。避ける (どうしても他が無ければ許容)。 */
  recentCombos?: ReadonlySet<string>;
  rand?: () => number;
}

function repoNameOf(originOrName: string): string {
  const withoutSuffix = originOrName.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  return (withoutSuffix.split(/[\\/:]/).pop() || withoutSuffix).toLowerCase();
}

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))]!;
}

/**
 * 別リポの 2 件を引き当てる。 biasRepos があれば A をそこへ寄せ (他サービスへの興味が
 * 主素材 — B は必ず別リポ)。 recentCombos は候補を先に除外し、代替が無い場合だけ再利用する。
 */
export function sampleWalkPair(materials: readonly WalkMaterial[], opts: SampleWalkPairOpts = {}): WalkPair | null {
  const rand = opts.rand ?? Math.random;
  const byRepo = new Map<string, WalkMaterial[]>();
  for (const material of materials) {
    const key = material.repo.toLowerCase();
    const bucket = byRepo.get(key) ?? [];
    bucket.push(material);
    byRepo.set(key, bucket);
  }
  if (byRepo.size < 2) return null;

  const biasKeys = [...new Set((opts.biasRepos ?? []).map(repoNameOf))].filter((key) => byRepo.has(key));
  const allKeys = [...byRepo.keys()];

  const aKeys = biasKeys.length > 0 ? biasKeys : allKeys;
  const candidates = aKeys.flatMap((aKey) => allKeys
    .filter((bKey) => bKey !== aKey)
    .map((bKey) => ({ aKey, bKey, comboKey: walkComboKey(aKey, bKey) })));
  const freshCandidates = candidates.filter((candidate) => !opts.recentCombos?.has(candidate.comboKey));
  const selected = pick(freshCandidates.length > 0 ? freshCandidates : candidates, rand);
  return {
    a: pick(byRepo.get(selected.aKey)!, rand),
    b: pick(byRepo.get(selected.bKey)!, rand),
    comboKey: selected.comboKey,
  };
}
