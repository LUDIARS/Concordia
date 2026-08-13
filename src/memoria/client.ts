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
        const text = await res.text().catch(() => "");
        throw new Error(`memoria ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
