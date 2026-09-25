import { z } from "zod";
import type { ActioAccess } from "./actio-binding.js";
import type { ActioTransport } from "./actio-transport.js";

const Projects = z.object({ projects: z.array(z.object({
  code: z.string().min(1), name: z.string().min(1), teamIds: z.array(z.string().min(1)),
})) });
export type ActioProject = z.infer<typeof Projects>["projects"][number];
export const LOCAL_ACTIO_ACCESS: Readonly<ActioAccess> = {
  ownerId: "actio-local", authMode: "loopback", subsidiaryId: null, teamId: null,
};

/** Registration is read from Actio; transport verifies its actual local identity first. */
export async function listLocalActioProjects(transport: Pick<ActioTransport, "request">): Promise<ActioProject[]> {
  const response = Projects.safeParse(await transport.request(LOCAL_ACTIO_ACCESS, "GET", "/api/projects/cc"));
  if (!response.success) throw new Error("Invalid Actio project list response");
  const codes = response.data.projects.map(project => project.code);
  if (new Set(codes).size !== codes.length) throw new Error("Actio project registration is ambiguous");
  return response.data.projects;
}
