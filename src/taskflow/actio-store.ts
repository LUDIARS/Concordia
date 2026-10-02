import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import { repositoryKey, type ActioBinding } from "./actio-binding.js";
import { matchesActioBindingScope, type ActioBindingReader, type ActioBindingScope } from "./actio-binding-scope.js";
import { workflowStatus, type ActioWorkflowClient, type ActioWorkflowTask } from "./actio-task-client.js";
import { ActioTeamCandidatesError, selectActioTeam } from "./actio-team-selection.js";
import { mainRepositoryKey } from "./repository-identity.js";
import type { TaskflowStateStore } from "./state-store.js";
import type { RemainingTasksInput, TaskCreateInput, TaskScanScope, TaskStore } from "./store.js";
import type { TaskDocument, TaskStatus } from "./types.js";
import { taskSessionMetadata } from "./session-metadata.js";
import { selectContinuationTask, taskWaitReason } from "./continuation-plan.js";
import type { TaskPrEvidence } from "./pr-evidence.js";

export const ACTIO_REFERENCE = /^actio:([A-Za-z0-9-]+)$/;

/** Actio is the only runtime content store. Cc persists references, never bodies. */
export class ActioTaskStore implements TaskStore {
  private readonly assignments = new Map<string, Promise<void>>();
  readonly authoritative = true;
  constructor(
    private readonly bindings: ActioBindingReader,
    private readonly client: ActioWorkflowClient,
    private readonly state: TaskflowStateStore,
  ) {}

  async scan(scope?: TaskScanScope): Promise<TaskDocument[]> {
    const selection = scope?.project ? { project: scope.project } : undefined;
    const documents: TaskDocument[] = [];
    for (const binding of await this.bindings(selection)) {
      // Older/custom readers can ignore selection; never read unrelated task bodies.
      if (!matchesActioBindingScope(binding, selection)) continue;
      for (const task of await this.client.list(binding)) documents.push(this.document(binding, task));
    }
    return documents;
  }

  async findForProject(project: string, statuses?: readonly TaskStatus[], subsidiaryId?: string | null): Promise<TaskDocument[]> {
    const binding = await this.binding(project, subsidiaryId);
    return (await this.client.list(binding)).map((task) => this.document(binding, task))
      .filter((task) => !statuses || statuses.includes(task.runtime!.status));
  }

  relativePath(document: TaskDocument): string { return document.path; }

  async nextExecutable(repoPath: string, subsidiaryId: string | null): Promise<TaskDocument | null> {
    const binding = await this.binding(repoPath, subsidiaryId);
    const selected = selectContinuationTask(await this.client.planning(binding));
    return selected ? this.document(binding, await this.client.get(binding, selected.id)) : null;
  }

  async canContinue(repoPath: string, reference: string, subsidiaryId: string | null, sessionId?: string): Promise<boolean> {
    const binding = await this.binding(repoPath, subsidiaryId);
    const tasks = await this.client.planning(binding);
    const task = tasks.find((item) => item.id === this.id(reference));
    return !!task && taskWaitReason(task, tasks, sessionId) === null;
  }

  async setPrEvidence(repoPath: string, reference: string, evidence: TaskPrEvidence, subsidiaryId: string | null): Promise<void> {
    await this.client.setPrEvidence(await this.binding(repoPath, subsidiaryId), this.id(reference), evidence);
  }

  associate(document: TaskDocument, runId: string, sessionId: string | null): void {
    const worker = taskSessionMetadata(document.frontmatter).working_session_id ?? sessionId;
    if (!this.state.claimActioExecution({ repoPath: document.repoPath, taskPath: document.path }, runId, worker)) {
      throw new Error("Actio task already associated with a delegation; inspect that run before retry");
    }
  }

  releaseExecution(runId: string): void { this.state.releaseActioExecution(runId); }

  async findByRelativePath(repoPath: string, reference: string): Promise<{ status: string } | null> {
    if (!ACTIO_REFERENCE.test(reference)) throw new Error("Legacy task file references require explicit Actio migration");
    const binding = await this.binding(repoPath);
    const task = await this.client.get(binding, this.id(reference));
    return { status: workflowStatus(task.status) };
  }

  async read(repoPath: string, reference: string, subsidiaryId: string | null): Promise<TaskDocument> {
    const binding = await this.binding(repoPath, subsidiaryId);
    return this.document(binding, await this.client.get(binding, this.id(reference)));
  }

  /**
   * 指示参照の関連付け・表示用 (CC-TASK-LINKED-FOLLOWUP)。v3 タスクは read と同じ文書を返す。
   * 旧来タスクは taskflow state に登録せず、runtime を持たない文書を返す (作業候補・状態更新の対象にしない)。
   */
  async readReference(repoPath: string, reference: string, subsidiaryId: string | null): Promise<TaskDocument> {
    const binding = await this.binding(repoPath, subsidiaryId);
    const { task, legacy } = await this.client.getReference(binding, this.id(reference));
    if (!legacy) return this.document(binding, task);
    return {
      path: `actio:${task.id}`, repoPath: binding.repoPath, title: task.title, body: task.description ?? "",
      frontmatter: { task: task.id, project: binding.project, actio_status: task.status, legacy_source: task.source,
        kind: "legacy", created: task.createdAt.slice(0, 10), due_at: task.deadline ?? null, memory_links: [] },
    };
  }

  async create(input: TaskCreateInput): Promise<TaskDocument> {
    const binding = selectActioTeam(await this.binding(input.repoPath, input.subsidiaryId), input.teamId);
    let result: Awaited<ReturnType<ActioWorkflowClient["create"]>>;
    try { result = await this.client.create(binding, input); }
    catch (error) {
      // A team-less task on a multi-team project may be refused; name the teams to choose from.
      if (binding.teamId !== null || !binding.teamCandidates?.length || !(error instanceof Error)) throw error;
      throw new ActioTeamCandidatesError(error.message, binding.teamCandidates);
    }
    return this.document(binding, result.task);
  }

  async updateStatus(repoPath: string, reference: string, status: TaskStatus, subsidiaryId: string | null): Promise<void> {
    const binding = await this.binding(repoPath, subsidiaryId);
    await this.client.setStatus(binding, this.id(reference), status);
  }

  async setWorkingSession(repoPath: string, reference: string, sessionId: string | null, subsidiaryId: string | null, expected?: string | null): Promise<void> {
    const binding = await this.binding(repoPath, subsidiaryId);
    const id = this.id(reference);
    const key = `${repositoryKey(binding.repoPath)}\0${subsidiaryId}\0${id}`;
    const previous = this.assignments.get(key);
    const operation = (async () => {
      // A failed predecessor reports its own error; subsequent reconciliation still runs.
      await previous?.catch(() => undefined);
      await this.client.setWorkingSession(binding, id, sessionId, expected);
      this.state.registerActioReference(binding.repoPath, reference, id, subsidiaryId);
      this.state.update({ repoPath: binding.repoPath, taskPath: reference }, { source_session: sessionId });
    })();
    this.assignments.set(key, operation);
    try { await operation; }
    finally { if (this.assignments.get(key) === operation) this.assignments.delete(key); }
  }

  async releaseWorkingSession(sessionId: string): Promise<void> {
    for (const row of this.state.assignmentsForSession(sessionId)) {
      const task = await this.read(row.repo_path, row.task_path, row.subsidiary_id);
      if (task.frontmatter.working_session_id !== sessionId) continue;
      await this.setWorkingSession(row.repo_path, row.task_path, null, row.subsidiary_id, sessionId);
    }
  }

  async writeRemainingTasks(input: RemainingTasksInput): Promise<{ created: string[]; existed: string[] }> {
    const binding = await this.binding(input.repoPath, input.subsidiaryId);
    const result: { created: string[]; existed: string[] } = { created: [], existed: [] };
    for (const [index, item] of input.remaining.entries()) {
      const sourceRef = createHash("sha256").update(JSON.stringify([
        binding.projectId, binding.subsidiaryId, input.sourceRunId, index, item.title,
      ])).digest("hex");
      const created = await this.client.create(binding, {
        issuedBySessionId: input.issuedBySessionId ?? null,
        sourceRef: `remaining:${sourceRef}`, title: item.title,
        body: [item.note ?? "", "", "## 完了条件", item.title, "", "## スコープ", ...(item.scope_dirs ?? [])].join("\n"),
        kind: "実装", memoryLinks: [],
      });
      const document = this.document(binding, created.task);
      result[created.existed ? "existed" : "created"].push(document.path);
    }
    return result;
  }

  async binding(selector: string, subsidiaryId?: string | null): Promise<ActioBinding> {
    const path = isAbsolute(selector) || win32.isAbsolute(selector);
    const key = path ? await mainRepositoryKey(selector) : selector.toLowerCase();
    const scope: ActioBindingScope = path ? { repoPath: key } : { project: key };
    const matches = (await this.bindings(scope)).filter((binding) =>
      matchesActioBindingScope(binding, scope)
      && (subsidiaryId === undefined || binding.subsidiaryId === subsidiaryId));
    if (matches.length !== 1) throw new Error("Actio task project binding missing or ambiguous");
    return matches[0]!;
  }

  private id(reference: string): string {
    const id = ACTIO_REFERENCE.exec(reference)?.[1];
    if (!id) throw new Error("Actio task reference required");
    return id;
  }

  private document(binding: ActioBinding, task: ActioWorkflowTask): TaskDocument {
    const reference = `actio:${task.id}`;
    const runtime = this.state.registerActioReference(binding.repoPath, reference, task.id, binding.subsidiaryId);
    const memory = task.pluginPayload?.memory_links;
    return {
      path: reference, repoPath: binding.repoPath, title: task.title,
      body: task.description ?? "",
      frontmatter: { task: task.id, project: binding.project,
        actio_status: task.status,
        ...taskSessionMetadata(task.pluginPayload),
        pull_requests: task.pluginPayload?.pull_requests ?? [],
        kind: typeof task.pluginPayload?.kind === "string" ? task.pluginPayload.kind : "実装",
        created: task.createdAt.slice(0, 10),
        due_at: task.deadline ?? null,
        memory_links: Array.isArray(memory) ? memory.filter((link): link is string => typeof link === "string") : [],
      },
      runtime: { ...runtime, status: workflowStatus(task.status) },
    };
  }
}
