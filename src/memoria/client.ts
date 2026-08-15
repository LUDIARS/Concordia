/**
 * Memoria (タスク管理、 既定 127.0.0.1:5180) の HTTP クライアント。
 *
 * これまで Concordia backend は Memoria を **読むだけ** (morning/scheduler.ts, discord/commands/mmtask.ts)
 * で、 タスクの作成は AI セッションへのプロンプト指示に任せていた。 確認タスク (develop に入った
 * 変更をユーザが動作確認する) は人間の介在なしに積まれる必要があるので、 ここで書き込み経路を持つ。
 *
 * spec/feature/develop-confirm-flow.md §5。
 */

import { memoriaBaseUrl } from "../config/service-urls.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("memoria/client");

const DEFAULT_TIMEOUT_MS = 15_000;

export interface MemoriaTask {
  id: number;
  title: string;
  status: string;
  /**
   * Memoria API (`GET/POST /api/tasks`) はタスク詳細も返す。 mmtask の詳細表示系が参照する。
   * 未設定のタスクでは null が返るため optional + nullable。
   */
  details?: string | null;
  category?: string | null;
  due_at?: string | null;
}

export interface CreateTaskInput {
  title: string;
  details?: string;
  category?: string;
  due_at?: string | null;
}

export interface MemoriaClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class MemoriaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MemoriaClientOptions = {}) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : memoriaBaseUrl();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createTask(input: CreateTaskInput): Promise<MemoriaTask> {
    const body = await this.request<{ task: MemoriaTask }>("POST", "/api/tasks", input);
    log.info({ task_id: body.task.id, title: input.title }, "memoria task created");
    return body.task;
  }

  /**
   * タスクの API リソース URL。 委託先へ「関連 Memoria タスク」として渡す。
   * Web UI の画面パスは Memoria 側の実装詳細なので推測せず、 契約済みの
   * `/api/tasks/:id` (createTask / completeTask と同じ面) を指す。
   */
  taskApiUrl(id: string | number): string {
    return `${this.baseUrl}/api/tasks/${id}`;
  }

  async completeTask(id: number): Promise<void> {
    await this.request("PATCH", `/api/tasks/${id}`, { status: "done" });
    log.info({ task_id: id }, "memoria task completed");
  }

  /**
   * 未完了タスクを新しい順に返す。 `/spawn` の task 候補 (spec/feature/teams.md §2) と、
   * 選択されたタスク本文の取得に使う。 Memoria が落ちていても spawn 自体は続けたいので、
   * 失敗は呼び出し側が握って空一覧に倒す。
   */
  async listOpenTasks(limit = 200): Promise<MemoriaTask[]> {
    const body = await this.get<{ tasks?: unknown }>(`/api/tasks?limit=${limit}`);
    if (!Array.isArray(body.tasks)) throw new Error("memoria task list response is invalid");
    const tasks = body.tasks.map(parseMemoriaTask);
    if (tasks.some((task) => task === null)) throw new Error("memoria task list contains an invalid task");
    return (tasks as MemoriaTask[]).filter((task) => task.status !== "done");
  }

  /** 1 件のタスク。 spawn 時に details を初回 prompt へ載せるために引く。 */
  async getTask(id: number): Promise<MemoriaTask | null> {
    const body = await this.get<{ task?: unknown }>(
      `/api/tasks/${id}`,
      { notFound: { task: null } },
    );
    if (body.task === null || body.task === undefined) return null;
    const task = parseMemoriaTask(body.task);
    if (!task) throw new Error(`memoria task response is invalid: ${id}`);
    return task;
  }

  private async get<T>(path: string, options?: { notFound: T }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (res.status === 404 && options) {
        await res.body?.cancel().catch(() => { /* best-effort response cleanup */ });
        return options.notFound;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => { /* best-effort response cleanup */ });
        throw new Error(`memoria GET ${path} failed: ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Response bodies may contain task details or upstream diagnostics. Do
        // not copy them into exceptions because callers log those exceptions.
        await res.body?.cancel().catch(() => { /* best-effort response cleanup */ });
        throw new Error(`memoria ${method} ${path} failed: ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseMemoriaTask(raw: unknown): MemoriaTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id <= 0) return null;
  if (typeof value.title !== "string" || typeof value.status !== "string") return null;
  const optionalString = (field: unknown): field is string | null | undefined =>
    field === undefined || field === null || typeof field === "string";
  if (!optionalString(value.details) || !optionalString(value.category) || !optionalString(value.due_at)) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    status: value.status,
    details: value.details,
    category: value.category,
    due_at: value.due_at,
  };
}
