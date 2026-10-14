/**
 * バグ報告の Actio タスク (spec/feature/bug-bounty.md §6 §8) の adapter。
 *
 * `POST /api/tasks` に `source: "concordia.bounty.v1"` / `sourceRef: <報告 id>` / 種別 `issue` / `lane: "backlog"` /
 * `executorType: "ai"` で作る。 投入先 (Actio の project / owner / team) は委託と同じ binding (taskflow) から
 * 対象プロジェクトの作業領域で引く。 チームが 0 件・複数なら決めずに失敗として返し、責任者 (assigneeId) は
 * LLM に決めさせない (ローカル運用は binding の owner、それ以外は決められないので失敗)。
 * Actio の source / sourceRef の一意制約で、再送しても同じタスクが返る (Actio 側の受け入れは別 PR、§14)。
 *
 * @implements SPEC-BOUNTY-FIX
 */

import type { ActioBinding } from "../taskflow/actio-binding.js";
import type { ActioBindingScope } from "../taskflow/actio-binding-scope.js";
import type { BountyActioError, BountyActioPort } from "./ports.js";

export const BOUNTY_ACTIO_SOURCE = "concordia.bounty.v1";
const ACTIO_REFERENCE = /^actio:([A-Za-z0-9-]+)$/u;

export interface BountyActioAdapterDeps {
  bindings(scope?: ActioBindingScope): Promise<readonly ActioBinding[]>;
  transport: { request(binding: ActioBinding, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> };
  repoPath(project: string): string | null;
}

type Resolved = { ok: true; binding: ActioBinding } | { ok: false; error: BountyActioError; detail: string };

async function resolveBinding(deps: BountyActioAdapterDeps, project: string, subsidiaryId: string | null): Promise<Resolved> {
  const repoPath = deps.repoPath(project);
  if (!repoPath) return { ok: false, error: "no_binding", detail: "project has no workspace" };
  let candidates: readonly ActioBinding[];
  try {
    candidates = await deps.bindings({ repoPath });
  } catch (error) {
    return { ok: false, error: "actio_unavailable", detail: (error as Error).message };
  }
  const matches = candidates.filter((binding) => binding.projectId === project && binding.subsidiaryId === subsidiaryId);
  if (matches.length === 0) return { ok: false, error: "no_binding", detail: `no Actio binding for ${project}` };
  if (matches.length > 1) return { ok: false, error: "team_ambiguous", detail: "several Actio bindings match" };
  const binding = matches[0]!;
  // チームが 0 件 (teamId null かつ候補なし) / 複数 (teamCandidates) は、どのチームに積むかを決められない。
  if (binding.teamId === null) return { ok: false, error: "team_ambiguous", detail: `${binding.teamCandidates?.length ?? 0} teams registered` };
  if (binding.authMode !== "loopback") return { ok: false, error: "assignee_unresolved", detail: "team default assignee is unknown" };
  return { ok: true, binding };
}

function classify(error: unknown): { error: BountyActioError; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/rejected \((4\d\d)\)/u.test(message)) return { error: "rejected", detail: message };
  return { error: "actio_unavailable", detail: message };
}

function taskId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const task = "task" in body ? (body as { task?: unknown }).task : body;
  const id = task && typeof task === "object" ? (task as { id?: unknown }).id : null;
  return typeof id === "string" && id ? id : null;
}

export function createBountyActioAdapter(deps: BountyActioAdapterDeps): BountyActioPort {
  return {
    async createIssueTask(input) {
      const resolved = await resolveBinding(deps, input.project, input.subsidiaryId);
      if (!resolved.ok) return resolved;
      const { binding } = resolved;
      try {
        const body = await deps.transport.request(binding, "POST", "/api/tasks", {
          title: input.title,
          description: input.description,
          projectId: binding.projectId,
          teamId: binding.teamId,
          assigneeId: binding.ownerId,
          source: BOUNTY_ACTIO_SOURCE,
          sourceRef: input.reportId,
          kind: "issue",
          lane: "backlog",
          executorType: "ai",
          creatorType: "ai",
          status: "open",
        });
        const id = taskId(body);
        if (!id) return { ok: false, error: "rejected", detail: "Actio returned no task id" };
        return { ok: true, taskRef: `actio:${id}` };
      } catch (error) {
        return { ok: false, ...classify(error) };
      }
    },
    async taskStatus(input) {
      const id = ACTIO_REFERENCE.exec(input.taskRef)?.[1];
      if (!id) return null;
      const resolved = await resolveBinding(deps, input.project, input.subsidiaryId);
      if (!resolved.ok) return null;
      try {
        const body = await deps.transport.request(resolved.binding, "GET", `/api/tasks/${encodeURIComponent(id)}`);
        const task = body && typeof body === "object" && "task" in body ? (body as { task?: { status?: unknown } }).task : body;
        const status = task && typeof task === "object" ? (task as { status?: unknown }).status : null;
        return typeof status === "string" ? status : null;
      } catch {
        return null;
      }
    },
  };
}
