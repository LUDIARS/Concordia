import { z } from "zod";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { ToolServiceHttp } from "../developer-tools/service-http.js";

type Service = "praeforma" | "anatomia";
export interface ContextLinkPort {
  request(service: Service, path: string): Promise<unknown>;
  verifiedBaseUrl(service: Service): Promise<string | null>;
}
export interface ContextLinks { praeforma: string; anatomia: string; anatomiaProjectId?: string; anatomiaBaseUrl?: string }

const AnatomyProjects = z.object({ projects: z.array(z.object({ id: z.string().min(1), rootPath: z.string().min(1) })) });
const PfPage = z.object({ items: z.array(z.object({ id: z.string().min(1), anatomiaRepo: z.string().nullable() })), total: z.number().int().nonnegative() });

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("context lookup timed out")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createContextLinkResolver(catalog: Pick<ExcubitorClient, "findService">):
  (repoPath: string, repoOrigin: string | null) => Promise<ContextLinks> {
  const http = new ToolServiceHttp(catalog);
  const port: ContextLinkPort = {
    request: (service, path) => http.request(service, path, undefined, 2_500),
    verifiedBaseUrl: async (service) => {
      const row = await catalog.findService(service, 5_000);
      if (!row || !["running", "healthy"].includes(row.state)) return null;
      const port = row.catalog_snapshot?.port !== undefined
        ? resolveServicePort({ port: row.catalog_snapshot.port }) : resolveServicePort(row);
      return port === null ? null : `http://127.0.0.1:${port}`;
    },
  };
  return (repoPath, repoOrigin) => resolveContextLinks({ repoPath, repoOrigin }, port);
}

/** Resolve each registered source independently; failure is absence, never a guessed link. */
export async function resolveContextLinks(
  input: { repoPath: string; repoOrigin: string | null }, port: ContextLinkPort,
): Promise<ContextLinks> {
  const root = await mainRepositoryKey(input.repoPath).catch(() => null);
  return resolveContextLinksForRoot(root, input.repoOrigin, port);
}

export async function resolveContextLinksForRoot(root: string | null, origin: string | null, port: ContextLinkPort): Promise<ContextLinks> {
  const anatomyId = root ? await within(anatomyRegistration(root, port), 4_000).catch(() => null) : null;
  const [anatomia, praeforma] = await Promise.all([
    anatomyId ? within(anatomyLink(anatomyId, port), 8_000).catch(() => "") : Promise.resolve(""),
    within(praeformaLink(origin, anatomyId, port), 8_000).catch(() => ""),
  ]);
  return { praeforma, anatomia, ...(anatomia && anatomyId
    ? { anatomiaProjectId: anatomyId, anatomiaBaseUrl: new URL(anatomia).origin } : {}) };
}

async function anatomyRegistration(root: string, port: ContextLinkPort): Promise<string | null> {
  const projects = AnatomyProjects.parse(await port.request("anatomia", "/api/projects")).projects
    .filter((item) => repositoryKey(item.rootPath) === root);
  if (projects.length !== 1) return null;
  return projects[0]!.id;
}

async function anatomyLink(id: string, port: ContextLinkPort): Promise<string> {
  const path = `/api/projects/${encodeURIComponent(id)}/domains`;
  await port.request("anatomia", path);
  const base = await port.verifiedBaseUrl("anatomia");
  return base ? `${base}${path}` : "";
}

async function praeformaLink(origin: string | null, anatomyId: string | null, port: ContextLinkPort): Promise<string> {
  const normalizedOrigin = origin ? normalizeRepoOrigin(origin) : null;
  if (!normalizedOrigin && !anatomyId) return "";
  const matches: Array<{ id: string; anatomiaRepo: string | null }> = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const page = PfPage.parse(await port.request("praeforma", `/api/projects?limit=100&offset=${offset}`));
    matches.push(...page.items.filter((item) => item.anatomiaRepo
      && ((normalizedOrigin && normalizeRepoOrigin(item.anatomiaRepo) === normalizedOrigin)
        || (anatomyId && item.anatomiaRepo === anatomyId))));
    if (offset + 100 >= page.total) break;
    if (offset === 200) return "";
  }
  if (matches.length !== 1) return "";
  const path = `/api/projects/${encodeURIComponent(matches[0]!.id)}`;
  await port.request("praeforma", path);
  const base = await port.verifiedBaseUrl("praeforma");
  return base ? `${base}${path}` : "";
}
