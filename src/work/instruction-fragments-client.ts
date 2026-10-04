import { z } from "zod";
import { ToolServiceHttp } from "../developer-tools/service-http.js";
import type { ExcubitorClient } from "../excubitor/client.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { syncInstructionFragments } from "./instruction-fragments.js";

export function createInstructionFragmentSync(catalog: Pick<ExcubitorClient, "findService">) {
  const http = new ToolServiceHttp(catalog);
  return (input: Parameters<typeof syncInstructionFragments>[1]) => syncInstructionFragments({
    project: async (repo, origin) => {
      const root = await mainRepositoryKey(repo);
      const anatomy = z.object({ projects: z.array(z.object({ id: z.string(), rootPath: z.string() })) })
        .parse(await http.request("anatomia", "/api/projects"));
      const registrations = anatomy.projects.filter(p => repositoryKey(p.rootPath) === root);
      if (registrations.length > 1) throw new Error("ambiguous_analysis_registration");
      const anatomyId = registrations[0]?.id;
      const matches: string[] = [];
      for (let offset = 0; offset < 10_000; offset += 100) {
        const page = z.object({ items: z.array(z.object({ id: z.string(), anatomiaRepo: z.string().nullable() })), total: z.number().int() })
          .parse(await http.request("praeforma", `/api/projects?limit=100&offset=${offset}`));
        matches.push(...page.items.filter(p => p.anatomiaRepo && (p.anatomiaRepo === anatomyId
          || (origin && normalizeRepoOrigin(p.anatomiaRepo) === normalizeRepoOrigin(origin)))).map(p => p.id));
        if (offset + 100 >= page.total) {
          if (matches.length > 1) throw new Error("ambiguous_spec_registration");
          return matches[0] ?? null;
        }
      }
      throw new Error("spec_catalog_limit");
    },
    post: async (project, fragment) => {
      // Use Pf's authenticated public contract; never forge a trusted Cc source/actor field.
      const response = z.object({ fragment: z.object({ id: z.string(), content: z.string(), sourceEventId: z.string() }) })
        .parse(await http.request("praeforma", `/api/projects/${encodeURIComponent(project)}/spec-fragments`, fragment));
      if (response.fragment.content !== fragment.content || response.fragment.sourceEventId !== fragment.sourceEventId) {
        throw new Error("fragment_receipt_mismatch");
      }
    },
  }, input);
}
