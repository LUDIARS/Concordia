import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NotionWorkPages } from "./notion-work-pages.js";
import { discordSource, mayWrite, routeMerge, routePost, workProjects, type WorkActor, type WorkBinding, type WorkPost, type WorkProject } from "./project-work-actions.js";

const inflight = new Map<string, Promise<void>>();
function ordered(source: string, work: () => Promise<void>) {
  const prior = inflight.get(source) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  inflight.set(source, next);
  return next.finally(() => { if (inflight.get(source) === next) inflight.delete(source); });
}

const providers = { notion: (credential: string, binding: WorkBinding) => new NotionWorkPages(credential, binding) };
function pages(project: WorkProject, binding: WorkBinding) {
  const key = project.repository.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const token = process.env["CC_NOTION_TOKEN_" + key];
  if (!token) throw new Error("missing Notion workflow credential");
  return providers[binding.provider](token, binding);
}

async function reserveCreation(source: string) {
  const directory = process.env.CC_PROJECT_WORK_ACTIONS + ".receipts";
  await mkdir(directory, { recursive: true });
  const file = join(directory, createHash("sha256").update(source).digest("hex"));
  await writeFile(file, source, { flag: "wx", mode: 0o600 });
}

export async function dispatchWorkPost(post: WorkPost, resolveActor: () => Promise<WorkActor>) {
  const route = routePost(workProjects(), post);
  if (!route) return;
  const source = discordSource(route.binding, post.id);
  await ordered(source, async () => {
    if (!mayWrite(route.binding, await resolveActor())) return;
    const target = pages(route.project, route.binding);
    const existing = await target.find(source);
    if (!existing) await reserveCreation(source);
    await target.save(source, route.text, existing);
  });
}

export async function dispatchWorkMerge(repository: string, base: string, head: string) {
  for (const route of routeMerge(workProjects(), repository, base, head)) {
    await ordered(route.source, async () => {
      const target = pages(route.project, route.binding);
      const page = await target.find(route.source);
      if (page) await target.complete(page, route.binding.done!);
    });
  }
}
