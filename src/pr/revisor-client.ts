import type { ExcubitorClient } from "../excubitor/client.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RevisorReviewRequest {
  repository: string;
  number: number;
  head_sha: string;
  head_ref: string;
  head_repository: string;
  base_ref: string;
  pull_request_url?: string;
  review_mode: "full" | "verification";
}

export interface RevisorReviewTrigger {
  enqueue(request: RevisorReviewRequest): Promise<{
    id: string;
    status: string;
    check_url?: string;
  }>;
}

interface RevisorClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class RevisorClient implements RevisorReviewTrigger {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RevisorClientOptions) {
    const token = options.token.trim();
    if (!token) throw new Error("Revisor trigger token is required");
    this.excubitor = options.excubitor;
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async enqueue(request: RevisorReviewRequest): Promise<{
    id: string;
    status: string;
    check_url?: string;
  }> {
    const service = await this.excubitor.findService(REVISOR_SERVICE_CODE);
    const port = service?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}/v1/pr-gate/jobs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            "x-concordia-actor": "concordia",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );
      const body = await response.json().catch(() => null) as {
        id?: unknown;
        status?: unknown;
        check_url?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor enqueue failed (${response.status})${detail}`);
      }
      if (typeof body?.id !== "string" || typeof body.status !== "string") {
        throw new Error("Revisor returned an invalid enqueue response");
      }
      return {
        id: body.id,
        status: body.status,
        check_url: typeof body.check_url === "string" ? body.check_url : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRevisorClientFromEnv(
  excubitor: Pick<ExcubitorClient, "findService">,
  env: NodeJS.ProcessEnv = process.env,
): RevisorClient | null {
  const token = env.CONCORDIA_REVISOR_TOKEN?.trim();
  return token ? new RevisorClient({ excubitor, token }) : null;
}
