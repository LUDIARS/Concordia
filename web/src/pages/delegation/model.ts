import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs, api, statusBadge, type ModelCatalogItem, type SessionRow } from "../../api.js";
import { RuntimeOptionsBuilder } from "../../components/RuntimeOptionsBuilder.js";

// gemma4-12 = ローカル LLM レーン (旧名 gamma。 内部は codex CLI を Ollama 経由、 推論は Gemma)。
// codex-sdk = Satelles ヘッドレスランナー (wt.exe / Lictor を使わない codex ファミリレーン)。
export type Provider = "claude" | "codex" | "codex-sdk" | "gemini" | "gemma4-12";

// 雇用形態カテゴリ (サーバ側正本: src/db/delegation-repo.ts DELEGATION_CATEGORIES)。
export type Category = "employee" | "freelancer" | "parttimer" | "test-qa";
export const CATEGORIES: readonly Category[] = ["employee", "freelancer", "parttimer", "test-qa"];
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  employee: "従業員",
  freelancer: "フリーランサー",
  parttimer: "パートタイマー",
  "test-qa": "テスト・QA",
};

export interface InputSchemaItem {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

export interface DelegationOptionChoice {
  label: string;
  value: string;
  description?: string;
}

export interface DelegationOptionSuggestion {
  key: string;
  label: string;
  type: "select" | "string" | "boolean" | "number";
  description?: string;
  choices?: DelegationOptionChoice[];
}

export interface Template {
  id: string;
  call_name: string;
  title: string;
  description: string;
  target_provider: Provider;
  model: string | null;
  prompt_template: string;
  input_schema: InputSchemaItem[];
  default_cwd: string | null;
  project: string | null;
  is_active: boolean;
  emoji: string;
  call_only: boolean;
  forum_tag: boolean;
  category: Category;
  sort_order: number;
  default_options?: Record<string, unknown>;
  runtime_options?: DelegationOptionSuggestion[];
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  template_id: string | null;
  call_name: string;
  target_provider: Provider;
  args: Record<string, unknown>;
  rendered_prompt: string;
  prompt_file_path: string;
  spawn_pid: number | null;
  spawn_command: string[] | null;
  triggered_by: string | null;
  status: "queued" | "pending" | "spawned" | "spawn_failed" | "running" | "completed" | "failed";
  error: string | null;
  effort_level: string | null;
  effort_source: string | null;
  effective_model: string | null;
  fast_mode: number;
  spawn_cwd: string | null;
  spawn_branch: string | null;
  spawn_worktree_path: string | null;
  spawn_worktree_created: number;
  /** queued の待ち順 (1 始まり)。 それ以外は null。 */
  queue_position: number | null;
  created_at: number;
  sessions?: SessionRow[];
}

/** 実行キューの状態 (GET /v1/delegation/queue)。 */
export interface QueueState {
  max_concurrency: number;
  active: number;
  queued: number;
}

export interface FormState {
  call_name: string;
  title: string;
  description: string;
  target_provider: Provider;
  model: string;
  prompt_template: string;
  input_schema_json: string;
  default_cwd: string;
  project: string;
  runtime_options_json: string;
  is_active: boolean;
  emoji: string;
  call_only: boolean;
  forum_tag: boolean;
  category: Category;
  sort_order: string;
}

export const EMPTY_FORM: FormState = {
  call_name: "",
  title: "",
  description: "",
  target_provider: "codex",
  model: "",
  prompt_template: "",
  input_schema_json: "[]",
  default_cwd: "",
  project: "",
  runtime_options_json: "{}",
  is_active: true,
  emoji: "",
  call_only: false,
  forum_tag: false,
  category: "employee",
  sort_order: "1000",
};

export type FormMode = { kind: "create" } | { kind: "edit"; templateId: string };

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export async function mutate(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Response> {
  // Concordia は loopback (既定 127.0.0.1:11111) 限定なので bearer token は不要。
  const headers: Record<string, string> = { "content-type": "application/json" };
  return fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

export function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function firstLine(text: string | null): string | null {
  if (!text) return null;
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

/** 外注 1 件のカード (進行中 / 完了履歴 で同じ見た目を使う)。 */
