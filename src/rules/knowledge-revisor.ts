/**
 * Revisor の直近 7 日のマージ済み PR の題の取り込み器 (spec/feature/patrol-chat.md「知識」)。
 *
 * リポごとに 1 文書。 全件取得 (種類ごと置き換え)。 公開範囲はプロジェクト一覧の行から決め、 一覧に無いリポは hq。
 */

import { clipBytes, type KnowledgeProject } from "./knowledge-ludiars.js";
import { knowledgeScopeOf } from "./knowledge-scope.js";
import { KNOWLEDGE_LIMITS, type KnowledgeCollector, type KnowledgeDoc, type KnowledgeScope } from "./knowledge-types.js";

export const REVISOR_KNOWLEDGE_LIMITS = { mergedWindowDays: 7, mergedTitlesPerRepo: 30 } as const;

export interface MergedPr {
  /** Revisor の repository (owner/name か name)。 */
  repository: string;
  title: string;
  /** マージ (決着) 時刻 (ms)。 */
  mergedAtMs: number;
}

export interface RevisorKnowledgeDeps {
  mergedPrs: (sinceMs: number) => Promise<MergedPr[]>;
  projects: () => KnowledgeProject[];
  publicProjects: () => string[];
  nowMs: () => number;
}

/** Revisor の repository からプロジェクトを引く (owner/name の name か、 プロジェクト名で一致)。 */
function projectForRepository(projects: KnowledgeProject[], repository: string): KnowledgeProject | null {
  const name = repository.split("/").pop()?.toLowerCase() ?? "";
  return projects.find((p) => p.project.toLowerCase() === name
    || (p.repoOrigin ?? "").toLowerCase().replace(/\.git$/, "").endsWith(`/${name}`)) ?? null;
}

export function createRevisorCollector(deps: RevisorKnowledgeDeps): KnowledgeCollector {
  return async () => {
    const since = deps.nowMs() - REVISOR_KNOWLEDGE_LIMITS.mergedWindowDays * 86_400_000;
    const prs = (await deps.mergedPrs(since)).filter((pr) => pr.mergedAtMs >= since && pr.title.trim());
    const projects = deps.projects();
    const publicList = deps.publicProjects();
    const byRepo = new Map<string, MergedPr[]>();
    for (const pr of prs) byRepo.set(pr.repository, [...(byRepo.get(pr.repository) ?? []), pr]);
    const docs: KnowledgeDoc[] = [];
    for (const [repository, list] of [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const project = projectForRepository(projects, repository);
      // 一覧に無いリポは公開範囲を判断できないので hq
      const scope: KnowledgeScope = project ? knowledgeScopeOf(project, publicList) : "hq";
      const titles = list.sort((a, b) => b.mergedAtMs - a.mergedAtMs).slice(0, REVISOR_KNOWLEDGE_LIMITS.mergedTitlesPerRepo);
      const label = project?.project ?? repository;
      docs.push({
        docType: "merged-pr",
        docKey: `merged:${repository}`,
        title: `${label} の直近 7 日のマージ`,
        url: null,
        repo: label,
        path: null,
        scope,
        text: clipBytes(titles.map((t) => `・${t.title.trim()}`).join("\n"), KNOWLEDGE_LIMITS.chunkBytes * 2),
        sourceUpdatedAt: Math.floor(titles[0]!.mergedAtMs / 1000),
      });
    }
    return { docs, full: true, cursor: null };
  };
}
