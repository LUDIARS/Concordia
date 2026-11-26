import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { roleAtLeast, type StaffRole } from "../staff/roles.js";

const snowflake = z.string().regex(/^\d{1,20}$/);
const binding = z.object({
  action: z.enum(["task", "proposal"]), guild: snowflake, channel: snowflake,
  prefix: z.string(), provider: z.literal("notion").default("notion"),
  dataSource: z.string().uuid(), initial: z.string().min(1),
  done: z.string().min(1).optional(),
  discordRoles: z.array(snowflake).min(1),
  minimumRole: z.enum(["staff", "manager", "executive"]),
}).strict();
const project = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), base: z.string().min(1),
  bindings: z.array(binding),
}).strict();
export type WorkProject = z.infer<typeof project>;
export type WorkBinding = z.infer<typeof binding>;
export interface WorkPost { guild: string; channel: string; id: string; text: string }
export interface WorkActor { role: StaffRole | null; discordRoles: readonly string[] }
export function mayWrite(binding: WorkBinding, actor: WorkActor): boolean {
  return actor.role !== null && roleAtLeast(actor.role, binding.minimumRole)
    && binding.discordRoles.some(id => actor.discordRoles.includes(id));
}
let cached: { path: string; modified: number; projects: WorkProject[] } | undefined;

export function workProjects(): WorkProject[] {
  const path = process.env.CC_PROJECT_WORK_ACTIONS;
  if (!path) return [];
  const modified = statSync(path).mtimeMs;
  if (cached?.path === path && cached.modified === modified) return cached.projects;
  const projects = z.array(project).parse(JSON.parse(readFileSync(path, "utf8")));
  const repositories = projects.map(p => p.repository.toLowerCase());
  if (new Set(repositories.map(r => r.replace(/[^a-z0-9]/g, "_"))).size !== repositories.length)
    throw new Error("duplicate workflow repository or credential key");
  const destinations = projects.flatMap(p => p.bindings.map(b => [p.repository, b.action, b.done ?? "", b.dataSource.toLowerCase()] as const));
  const owners = new Map<string, string>();
  for (const [repo, action, done, dataSource] of destinations) {
    const owner = JSON.stringify([repo, action, done]);
    if (owners.has(dataSource) && owners.get(dataSource) !== owner) throw new Error("conflicting workflow destination");
    owners.set(dataSource, owner);
  }
  cached = { path, modified, projects };
  return projects;
}

export function routePost(projects: WorkProject[], post: WorkPost) {
  const routes = projects.flatMap(project => project.bindings
    .filter(b => b.guild === post.guild && b.channel === post.channel && post.text.startsWith(b.prefix))
    .map(binding => ({ project, binding, text: post.text.slice(binding.prefix.length).trim() })));
  if (routes.length > 1) throw new Error("ambiguous workflow channel");
  return routes[0]?.text ? routes[0] : undefined;
}

export function routeMerge(projects: WorkProject[], repository: string, base: string, head: string) {
  const id = /(?:^|\/)cc-task-(\d{1,20})$/.exec(head)?.[1];
  const project = projects.find(p => p.repository.toLowerCase() === repository.toLowerCase() && p.base === base);
  if (!id || !project) return [];
  return project.bindings.filter(b => b.action === "task" && b.done)
    .map(binding => ({ project, binding, source: discordSource(binding, id) }));
}

export function discordSource(binding: Pick<WorkBinding, "guild" | "channel">, id: string) {
  return `https://discord.com/channels/${binding.guild}/${binding.channel}/${id}`;
}
