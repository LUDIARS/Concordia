import type { TaskStore } from "../taskflow/store.js";
import type { TaskDocument } from "../taskflow/types.js";
import type { DelegationDefinition, InvokeInput } from "./contracts.js";
import { substituteVars } from "./prompt.js";
import { deriveTaskTitle } from "./task-title.js";
import { resolveWorkUnit } from "./work-key.js";

/** 同じ (リポジトリ, ブランチ) で終わった前の run の task 参照 (delegation/handoff-task.ts)。 */
export type HandoffReferenceFinder = (target: { repoPath: string; branch: string | null }) => string | null;

/**
 * 委託の task を決める (spec/feature/task-workflow-v3.md §work key)。
 * 明示の参照 → 引き継ぎの自動判定 → 作業単位のキーで作成/再利用、の順。
 */
async function resolveTask(input: {
  store: TaskStore; definition: DelegationDefinition; invocation: InvokeInput; cwd: string; content: string;
  findHandoffReference?: HandoffReferenceFinder;
}): Promise<TaskDocument> {
  const { store, definition, invocation, cwd } = input;
  const subsidiaryId = invocation.subsidiary_id ?? null;
  const branch = invocation.branch ?? null;
  const title = deriveTaskTitle({ args: invocation.args, content: input.content, fallback: definition.title });
  const unit = resolveWorkUnit({ args: invocation.args, repoPath: cwd, branch, title });
  if (unit.kind === "reference") {
    if (!store.read) throw new Error("Actio task store and repository binding are required");
    return store.read(cwd, unit.reference, subsidiaryId);
  }
  const handoff = input.findHandoffReference?.({ repoPath: cwd, branch }) ?? null;
  if (handoff && store.read) {
    const task = await store.read(cwd, handoff, subsidiaryId);
    // 終わった task は引き継がない。作業単位のキーで新しく決める。
    if (task.runtime?.status !== "done" && task.runtime?.status !== "cancelled") return task;
  }
  return store.create!({
    issuedBySessionId: invocation.parent_session_id ?? null,
    repoPath: cwd, subsidiaryId, teamId: invocation.actio_team_id ?? null,
    sourceRef: unit.sourceRef, title, template: definition.title, reuseExisting: true, body: input.content,
    kind: "実装", memoryLinks: invocation.memory_links ?? [], status: "delegated",
  });
}

/** Move rendered content to Actio before the run/queue/prompt can persist it. */
export async function sealDelegationTask(input: {
  store: TaskStore; definition: DelegationDefinition; invocation: InvokeInput; runId: string; content: string;
  findHandoffReference?: HandoffReferenceFinder;
}): Promise<{ definition: DelegationDefinition; invocation: InvokeInput; prompt: string; reference: string }> {
  const { definition, invocation, store } = input;
  const cwd = invocation.cwd ?? (definition.default_cwd ? substituteVars(definition.default_cwd, invocation.args).trim() : "");
  if (!cwd || !store.create) throw new Error("Actio task store and repository binding are required");
  const task = await resolveTask({ ...input, cwd });
  const prompt = [
    `Actio タスク参照: ${task.path}`,
    "自分の session_id を使い、GET /v1/taskflow/tasks/content?session_id=<自分>&reference=" + task.path + " から本文を取得して実装してください。",
    "取得できなければ停止して報告してください。本文をファイルや PR へ自動転記しないでください。",
  ].join("\n");
  store.associate?.(task, input.runId, null);
  try {
    // 続きの指示は本文へ追記する (同じ本文なら追記しない)。子は追記込みの本文を Actio から読む。
    await store.recordRunStart?.(task, { runId: input.runId, sessionId: null, instruction: input.content });
  } catch (error) {
    store.releaseExecution?.(input.runId);
    throw error;
  }
  return {
    reference: task.path, prompt,
    definition: { ...definition, prompt_template: prompt, input_schema: "[]", default_cwd: cwd },
    invocation: { ...invocation, cwd, extra_prompt: undefined, memory_links: [],
      args: { target_repo: cwd, taskflow_reference: task.path },
      memoria_task_id: undefined, memoria_task_title: undefined },
  };
}
