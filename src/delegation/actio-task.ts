import type { TaskStore } from "../taskflow/store.js";
import type { DelegationDefinition, InvokeInput } from "./contracts.js";
import { substituteVars } from "./prompt.js";
import { createHash } from "node:crypto";

/** Move rendered content to Actio before the run/queue/prompt can persist it. */
export async function sealDelegationTask(input: {
  store: TaskStore; definition: DelegationDefinition; invocation: InvokeInput; runId: string; content: string;
}): Promise<{ definition: DelegationDefinition; invocation: InvokeInput; prompt: string; reference: string }> {
  const { definition, invocation, store } = input;
  const cwd = invocation.cwd ?? (definition.default_cwd ? substituteVars(definition.default_cwd, invocation.args).trim() : "");
  if (!cwd || !store.create) throw new Error("Actio task store and repository binding are required");
  const task = await store.create({
    repoPath: cwd, subsidiaryId: invocation.subsidiary_id ?? null,
    // Stable even when the POST response is lost before the run exists locally.
    sourceRef: `delegation:${createHash("sha256").update(JSON.stringify([
      invocation.parent_session_id ?? null, definition.template_id ?? definition.call_name,
      invocation.branch ?? null, input.content,
    ])).digest("hex")}`, title: definition.title, body: input.content,
    kind: "実装", memoryLinks: invocation.memory_links ?? [], status: "delegated",
  });
  const prompt = [
    `Actio タスク参照: ${task.path}`,
    "自分の session_id を使い、GET /v1/taskflow/tasks/content?session_id=<自分>&reference=" + task.path + " から本文を取得して実装してください。",
    "取得できなければ停止して報告してください。本文をファイルや PR へ自動転記しないでください。",
  ].join("\n");
  store.associate?.(task, input.runId, invocation.parent_session_id ?? null);
  return {
    reference: task.path, prompt,
    definition: { ...definition, prompt_template: prompt, input_schema: "[]", default_cwd: cwd },
    invocation: { ...invocation, cwd, extra_prompt: undefined, memory_links: [],
      args: { target_repo: cwd, taskflow_reference: task.path },
      memoria_task_id: undefined, memoria_task_title: undefined },
  };
}
