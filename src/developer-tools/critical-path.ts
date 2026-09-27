import { z } from "zod";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import type { ActioTransport } from "../taskflow/actio-transport.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { unavailable } from "./contracts.js";

/** PM and task/team Gantt are distinct Actio models; never guess one model's ID from the other. */
export async function criticalPath(transport: Pick<ActioTransport, "request">, binding: ActioBinding,
  origin: string | null, pmProjectId?: string): Promise<unknown> {
  if (binding.teamId && !pmProjectId) return transport.request(binding, "GET", `/api/teams/${encodeURIComponent(binding.teamId)}/critical-path`);
  if (binding.subsidiaryId || !origin) unavailable("critical_path_binding_required", "対象 team の binding、または本社 owner の Git repo に紐付く Actio PM project を準備してください。");
  // Do not return or persist the PM sourceConfig, which can contain provider credentials.
  const response = z.object({ projects: z.array(z.object({ id: z.string(), ownerId: z.string(), source: z.string(),
    sourceConfig: z.object({ owner: z.string().optional(), repo: z.string().optional() }).passthrough() })) })
    .parse(await transport.request(binding, "GET", "/api/pm/projects"));
  const matches = response.projects.filter(project => project.ownerId === binding.ownerId
    && project.source === "github" && project.sourceConfig.owner && project.sourceConfig.repo
    && normalizeRepoOrigin(`${project.sourceConfig.owner}/${project.sourceConfig.repo}`).toLowerCase() === normalizeRepoOrigin(origin).toLowerCase()
    && (!pmProjectId || pmProjectId === project.id));
  if (matches.length !== 1) unavailable("pm_project_missing_or_ambiguous", "Actio PM に同じ owner・Git repo の project を準備してください。複数登録なら pm_project_id を指定してください。");
  return transport.request(binding, "GET", `/api/pm/projects/${encodeURIComponent(matches[0]!.id)}/analytics/critical-path`);
}
