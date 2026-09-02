// Revisor repository registration の read/update client。
// @implements spec/feature/project-code-registry.md — 管理 UI / Revisor workflow
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { toTokenResolver } from "./revisor-token.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RevisorRepositoryRecord {
  repository: string;
  rootPath: string;
  baseRef: string;
  workflow?: "revisor" | "github";
  testCases: Array<{
    name: string;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    kinds?: string[] | null;
    runtime?: boolean;
    always?: boolean;
  }>;
}

export interface RevisorRepositoryAdmin {
  listRepositories(): Promise<RevisorRepositoryRecord[]>;
  setRepositoryWorkflow(record: RevisorRepositoryRecord, workflow: "revisor" | "github"): Promise<void>;
}

interface RevisorRepositoryClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  token?: string | (() => string | undefined);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class RevisorRepositoryClient implements RevisorRepositoryAdmin {
  private readonly token: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RevisorRepositoryClientOptions) {
    this.token = toTokenResolver(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listRepositories(): Promise<RevisorRepositoryRecord[]> {
    const response = await this.request();
    const body = await response.json().catch(() => null) as
      | { repositories?: unknown; error?: unknown }
      | null;
    if (!response.ok) {
      const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
      throw new Error(`Revisor repository listing failed (${response.status})${detail}`);
    }
    if (!Array.isArray(body?.repositories)) {
      throw new Error("Revisor returned an invalid repository listing");
    }
    return body.repositories.flatMap(parseRepositoryRecord);
  }

  async setRepositoryWorkflow(
    record: RevisorRepositoryRecord,
    workflow: "revisor" | "github",
  ): Promise<void> {
    const token = this.token();
    if (!token) throw new Error("Revisor workflow token is required (workflow token unset)");
    const response = await this.request({
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repository: record.repository,
        root_path: record.rootPath,
        base_ref: record.baseRef,
        test_cases: record.testCases.map((testCase) => ({
          name: testCase.name,
          command: testCase.command,
          args: testCase.args,
          cwd: testCase.cwd,
          timeout_ms: testCase.timeoutMs,
          kinds: testCase.kinds ?? null,
          runtime: testCase.runtime === true,
          always: testCase.always === true,
        })),
        workflow,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
      throw new Error(`Revisor repository workflow update failed (${response.status})${detail}`);
    }
  }

  private async request(init?: RequestInit): Promise<Response> {
    const service = await this.options.excubitor.findService(REVISOR_SERVICE_CODE);
    const port = resolveServicePort(service);
    if (port === null) throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`http://127.0.0.1:${port}/v1/repositories`, {
        ...init,
        headers: {
          "x-concordia-actor": "concordia",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRepositoryRecord(value: unknown): RevisorRepositoryRecord[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (
    typeof row.repository !== "string"
    || typeof row.rootPath !== "string"
    || typeof row.baseRef !== "string"
    || !Array.isArray(row.testCases)
    || (row.workflow !== undefined && row.workflow !== "revisor" && row.workflow !== "github")
  ) return [];
  const testCases = row.testCases.flatMap(parseRepositoryTestCase);
  if (testCases.length !== row.testCases.length) return [];
  return [{
    repository: row.repository,
    rootPath: row.rootPath,
    baseRef: row.baseRef,
    workflow: row.workflow as "revisor" | "github" | undefined,
    testCases,
  }];
}

function parseRepositoryTestCase(value: unknown): RevisorRepositoryRecord["testCases"] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (
    typeof row.name !== "string"
    || typeof row.command !== "string"
    || !Array.isArray(row.args)
    || !row.args.every((arg) => typeof arg === "string")
    || typeof row.cwd !== "string"
    || typeof row.timeoutMs !== "number"
    || (row.kinds !== undefined && row.kinds !== null
      && (!Array.isArray(row.kinds) || !row.kinds.every((kind) => typeof kind === "string")))
  ) return [];
  return [{
    name: row.name,
    command: row.command,
    args: row.args as string[],
    cwd: row.cwd,
    timeoutMs: row.timeoutMs,
    kinds: row.kinds as string[] | null | undefined,
    runtime: row.runtime === true,
    always: row.always === true,
  }];
}

export function createRevisorRepositoryClient(
  excubitor: Pick<ExcubitorClient, "findService">,
  resolveToken: () => string | undefined,
): RevisorRepositoryClient {
  return new RevisorRepositoryClient({
    excubitor,
    token: () => resolveToken()?.trim() || "",
  });
}
