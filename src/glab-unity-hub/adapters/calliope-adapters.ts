/**
 * カリオペの素材集めと文章化 (契約 v1 §4c)。
 *
 * 素材 (取れたものだけ使い、 取れなかったものは出所に載せない):
 * - Anatomia の business-domain-view (domain-review と同じ取得経路 AnatomiaDomainClient)
 * - 対象リポの spec/ux/*.md
 * - Praeforma のプロジェクト情報 (ux-goal)
 * - Breviarium の状態 (overview)
 *
 * 文章化は Concordia の既存の 1 回きりの文章生成 (runAvailableText、 ツール無し) を使う。
 *
 * @implements spec/feature/glab-unity-hub.md §4c (GUH-CALLIOPE)
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnatomiaDomainClient } from "../../domain-review/anatomia-client.js";
import type { CalliopeMaterial } from "../domain/calliope-product.js";
import type { CalliopeMaterialsPort, CalliopeWriterPort, Clock } from "../application/ports.js";
import type { HubProject } from "./hub-config.js";
import type { LoopbackServiceHttp } from "./service-http.js";

const MAX_UX_FILES = 12;

export class CalliopeMaterials implements CalliopeMaterialsPort {
  constructor(private readonly deps: {
    readonly projects: readonly HubProject[];
    readonly anatomia: Pick<AnatomiaDomainClient, "resolveProjectId" | "fetchBusinessDomainView">;
    readonly http: Pick<LoopbackServiceHttp, "request">;
    readonly clock: Clock;
  }) {}

  async collect(projectCode: string): Promise<CalliopeMaterial[]> {
    const project = this.deps.projects.find((entry) => entry.code === projectCode);
    if (!project) return [];
    const results = await Promise.all([
      this.anatomia(project),
      this.uxSpecs(project),
      this.praeforma(project),
      this.breviarium(project),
    ]);
    return results.filter((material): material is CalliopeMaterial => material !== null && material.text.trim() !== "");
  }

  private stamp(name: string, text: string): CalliopeMaterial {
    return { name, fetchedAt: this.deps.clock.now().toISOString(), text };
  }

  private async anatomia(project: HubProject): Promise<CalliopeMaterial | null> {
    if (!project.repoPath) return null;
    const id = await this.deps.anatomia.resolveProjectId(project.repoPath).catch(() => null);
    if (!id?.ok || !id.data) return null;
    const view = await this.deps.anatomia.fetchBusinessDomainView(id.data).catch(() => null);
    if (!view?.ok) return null;
    return this.stamp("anatomia.business-domain-view", JSON.stringify(view.data, null, 1));
  }

  private async uxSpecs(project: HubProject): Promise<CalliopeMaterial | null> {
    if (!project.repoPath) return null;
    const dir = join(project.repoPath, "spec", "ux");
    const names = await readdir(dir).catch(() => [] as string[]);
    const files = names.filter((name) => name.endsWith(".md")).sort().slice(0, MAX_UX_FILES);
    const parts: string[] = [];
    for (const name of files) {
      const text = await readFile(join(dir, name), "utf8").catch(() => "");
      if (text) parts.push(`### spec/ux/${name}\n\n${text}`);
    }
    return parts.length > 0 ? this.stamp("repo.spec/ux", parts.join("\n\n")) : null;
  }

  private async praeforma(project: HubProject): Promise<CalliopeMaterial | null> {
    if (!project.praeformaProjectId) return null;
    const goal = await this.deps.http.request("praeforma", "GET", `/api/projects/${encodeURIComponent(project.praeformaProjectId)}/ux-goal`).catch(() => null);
    return goal === null ? null : this.stamp("praeforma.ux-goal", JSON.stringify(goal, null, 1));
  }

  private async breviarium(project: HubProject): Promise<CalliopeMaterial | null> {
    const overview = await this.deps.http.request("breviarium", "GET", `/api/projects/${encodeURIComponent(project.breviariumProject)}/overview`).catch(() => null);
    return overview === null ? null : this.stamp("breviarium.overview", JSON.stringify(overview, null, 1));
  }
}

/** 文章生成の実行面 (テストで差し替える)。 */
export type TextRunner = (prompt: string, options: { tier?: "high"; timeoutMs?: number }) => Promise<{ ok: boolean; stdout: string }>;

export class OneShotCalliopeWriter implements CalliopeWriterPort {
  constructor(private readonly run: TextRunner) {}

  async write(prompt: string): Promise<string | null> {
    const result = await this.run(prompt, { tier: "high", timeoutMs: 300_000 });
    return result.ok && result.stdout.trim() !== "" ? result.stdout : null;
  }
}
