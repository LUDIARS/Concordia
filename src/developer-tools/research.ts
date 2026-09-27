import { z } from "zod";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { unavailable } from "./contracts.js";
import type { ToolServiceHttp } from "./service-http.js";

export class ResearchTools {
  constructor(private readonly http: ToolServiceHttp) {}
  async anatomyProject(repoPath: string): Promise<string> {
    const root = await mainRepositoryKey(repoPath);
    const result = z.object({ projects: z.array(z.object({ id: z.string(), rootPath: z.string() })) })
      .parse(await this.http.request("anatomia", "/api/projects"));
    const matches = result.projects.filter(project => repositoryKey(project.rootPath) === root);
    if (matches.length !== 1) unavailable("analysis_project_missing_or_ambiguous", "Anatomia にこの Git 本体 root を一意に登録して解析を準備してください。");
    return matches[0]!.id;
  }
  async context(repoPath: string, task: string): Promise<unknown> {
    const project = await this.anatomyProject(repoPath);
    return this.http.request("anatomia", `/api/context?${new URLSearchParams({ project, task })}`);
  }
  async impact(repoPath: string, task: string): Promise<unknown> {
    const project = await this.anatomyProject(repoPath);
    return this.http.request("anatomia", "/api/plan", { project, task, llm: false, map: false });
  }
  async specifications(origin: string | null, projectId?: string, repoPath?: string): Promise<unknown> {
    const repo = origin ? normalizeRepoOrigin(origin) : null;
    if (!repo) unavailable("repository_origin_required", "登録 repository origin を確認してください。");
    const schema = z.object({ id: z.string(), anatomiaRepo: z.string().nullable() });
    const matches: z.infer<typeof schema>[] = [];
    const candidates: z.infer<typeof schema>[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = z.object({ items: z.array(schema), total: z.number().int().nonnegative() })
        .parse(await this.http.request("praeforma", `/api/projects?limit=100&offset=${offset}`));
      matches.push(...page.items.filter(item => item.anatomiaRepo
        && normalizeRepoOrigin(item.anatomiaRepo) === repo && (!projectId || item.id === projectId)));
      candidates.push(...page.items.filter(item => item.anatomiaRepo && (!projectId || item.id === projectId)));
      if (offset + 100 >= page.total) {
        if (!matches.length && repoPath) {
          // Pf also accepts the exact Anatomia registry ID. Resolve that ID from Git root, never from repo-name guessing.
          const anatomyId = await this.anatomyProject(repoPath);
          matches.push(...candidates.filter(item => item.anatomiaRepo === anatomyId));
        }
        if (matches.length !== 1) unavailable("spec_project_missing_or_ambiguous", "Pf の anatomiaRepo を対象 Git origin に紐付け、重複時は project_id を指定してください。");
        const id = matches[0]!.id;
        return { project_id: id, source: "Praeforma", model: await this.http.request("praeforma", `/api/projects/${encodeURIComponent(id)}/export/model.json`) };
      }
    }
    return unavailable("project_catalog_limit", "Pf のプロジェクト一覧が取得上限を超えています。管理者に確認してください。");
  }
}
