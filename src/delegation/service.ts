/**
 * Delegation service: テンプレ render + invoke (spawn 連携 + 記録).
 *
 * spec/delegation.md §3-4.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type DelegationRepo,
  type DelegationProvider,
  type DelegationRunRow,
  type DelegationTemplateRow,
  type InputSchemaItem,
  parseInputSchema,
} from "../db/delegation-repo.js";
import { spawnSession, type SpawnRequest } from "../control/spawner.js";

export interface RenderResult {
  rendered: string;
  missing: string[];     // required but absent
  unknown_vars: string[]; // referenced in template but not in schema (warning)
}

const VAR_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g;

export function renderTemplate(
  template: string,
  args: Record<string, unknown>,
  schema: InputSchemaItem[],
): RenderResult {
  const missing: string[] = [];
  const unknown: Set<string> = new Set();
  const required = new Set(schema.filter((s) => s.required).map((s) => s.name));
  const known = new Set(schema.map((s) => s.name));
  // First fill in defaults from schema for any missing args
  const filledArgs: Record<string, unknown> = { ...args };
  for (const s of schema) {
    if (filledArgs[s.name] === undefined && s.default !== undefined) {
      filledArgs[s.name] = s.default;
    }
  }
  // Required check
  for (const r of required) {
    const v = filledArgs[r];
    if (v === undefined || v === null || v === "") missing.push(r);
  }
  const rendered = template.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    if (!known.has(name)) unknown.add(name);
    const v = filledArgs[name];
    if (v !== undefined && v !== null && v !== "") return String(v);
    return fallback ?? "";
  });
  return { rendered, missing, unknown_vars: Array.from(unknown) };
}

export function validateArgs(
  args: Record<string, unknown>,
  schema: InputSchemaItem[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const s of schema) {
    const v = args[s.name];
    if (v === undefined || v === null) {
      if (s.required && s.default === undefined) {
        errors.push(`missing required arg: ${s.name}`);
      }
      continue;
    }
    const t = typeof v;
    if (s.type === "string" && t !== "string") errors.push(`arg ${s.name} must be string`);
    if (s.type === "number" && t !== "number") errors.push(`arg ${s.name} must be number`);
    if (s.type === "boolean" && t !== "boolean") errors.push(`arg ${s.name} must be boolean`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export interface InvokeInput {
  call_name: string;
  args: Record<string, unknown>;
  cwd?: string;
  triggered_by?: string;
  /** false で spawn せず render + 記録のみ */
  spawn?: boolean;
}

export interface InvokeResultOk {
  ok: true;
  run: DelegationRunRow;
  prompt_file_path: string;
  rendered_prompt: string;
  spawn_pid: number | null;
  spawn_command: string[] | null;
}

export interface InvokeResultErr {
  ok: false;
  error: string;
  details?: unknown;
}

export type InvokeResult = InvokeResultOk | InvokeResultErr;

export interface DelegationServiceDeps {
  repo: DelegationRepo;
  /** 端末 spawn を上書き (テスト用)。 省略時は実際に wt.exe を起動 */
  spawn?: (req: SpawnRequest) => { ok: true; pid: number | null; command: string[] } | { ok: false; error: string };
  /** prompt file の出力先 dir (default = process.cwd()/delegation-prompts) */
  promptsDir?: string;
}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  private get promptsDir(): string {
    return this.deps.promptsDir ?? join(process.cwd(), "delegation-prompts");
  }

  invoke(input: InvokeInput): InvokeResult {
    const tpl = this.deps.repo.findTemplateByCallName(input.call_name);
    if (!tpl) return { ok: false, error: `unknown call_name: ${input.call_name}` };
    if (!tpl.is_active) return { ok: false, error: `template is inactive: ${input.call_name}` };
    const schema = parseInputSchema(tpl.input_schema);
    const validation = validateArgs(input.args ?? {}, schema);
    if (!validation.ok) {
      return { ok: false, error: "invalid args", details: validation.errors };
    }
    const render = renderTemplate(tpl.prompt_template, input.args ?? {}, schema);
    if (render.missing.length > 0) {
      return { ok: false, error: "missing required args", details: render.missing };
    }
    const provider = tpl.target_provider as DelegationProvider;
    const cwd = input.cwd ?? tpl.default_cwd ?? undefined;

    // 1) write prompt to file (pre-allocate run id so file name == row id)
    mkdirSync(this.promptsDir, { recursive: true });
    const runId = randomUUID();
    const promptPath = join(this.promptsDir, `${runId}.md`);
    const promptBody = renderPromptFile(tpl, render.rendered, input.args ?? {}, runId);
    try {
      writeFileSync(promptPath, promptBody, "utf8");
    } catch (err) {
      return { ok: false, error: `failed to write prompt file: ${(err as Error).message}` };
    }

    // 2) spawn (optional)
    let spawnPid: number | null = null;
    let spawnCommand: string[] | null = null;
    let status: DelegationRunRow["status"] = "pending";
    let spawnError: string | null = null;
    const shouldSpawn = input.spawn !== false;
    if (shouldSpawn) {
      const spawner = this.deps.spawn ?? ((req) => spawnSession(req));
      const req: SpawnRequest = {
        provider,
        mode: "tab",
        cwd: cwd ?? undefined,
        title: `delegation:${input.call_name}`,
        env: {
          CONCORDIA_DELEGATION_PROMPT_FILE: promptPath,
          CONCORDIA_DELEGATION_RUN_ID: runId,
          CONCORDIA_DELEGATION_CALL_NAME: input.call_name,
        },
      };
      const result = spawner(req);
      if (result.ok) {
        spawnPid = result.pid;
        spawnCommand = result.command;
        status = "spawned";
      } else {
        status = "spawn_failed";
        spawnError = result.error;
      }
    }

    // 3) record run (pass pre-allocated runId so prompt_file_path matches run.id)
    const run = this.deps.repo.createRun({
      id: runId,
      template_id: tpl.id,
      call_name: tpl.call_name,
      target_provider: provider,
      args: input.args ?? {},
      rendered_prompt: render.rendered,
      prompt_file_path: promptPath,
      spawn_pid: spawnPid,
      spawn_command: spawnCommand,
      triggered_by: input.triggered_by ?? null,
      status,
      error: spawnError,
    });

    return {
      ok: true,
      run,
      prompt_file_path: promptPath,
      rendered_prompt: render.rendered,
      spawn_pid: spawnPid,
      spawn_command: spawnCommand,
    };
  }
}

function renderPromptFile(
  tpl: DelegationTemplateRow,
  rendered: string,
  args: Record<string, unknown>,
  runId: string,
): string {
  const argsBlock = Object.keys(args).length === 0
    ? "(none)"
    : Object.entries(args).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n");
  return [
    `# Delegation: ${tpl.call_name}`,
    "",
    `- run_id: ${runId}`,
    `- target_provider: ${tpl.target_provider}`,
    `- template_title: ${tpl.title}`,
    "",
    "## Args",
    "",
    argsBlock,
    "",
    "## Prompt",
    "",
    rendered,
    "",
  ].join("\n");
}
