import type { ExcubitorClient } from "../excubitor/client.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RevisorTestWorkflowProduct {
  repository: string;
  pullRequestId: string;
  number: number;
  title: string;
  status: "Open / Test OK";
  reviewedHeadSha: string;
  updatedAt: string;
}

export interface RevisorTestWorkflowSource {
  listProducts(): Promise<readonly RevisorTestWorkflowProduct[]>;
}

interface RevisorTestWorkflowClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isProduct(value: unknown): value is RevisorTestWorkflowProduct {
  if (!value || typeof value !== "object") return false;
  const product = value as Record<string, unknown>;
  return typeof product.repository === "string"
    && product.repository.trim().length > 0
    && typeof product.pullRequestId === "string"
    && product.pullRequestId.trim().length > 0
    && typeof product.number === "number"
    && Number.isInteger(product.number)
    && product.number > 0
    && typeof product.title === "string"
    && product.status === "Open / Test OK"
    && typeof product.reviewedHeadSha === "string"
    && product.reviewedHeadSha.trim().length > 0
    && typeof product.updatedAt === "string";
}

export class RevisorTestWorkflowClient implements RevisorTestWorkflowSource {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RevisorTestWorkflowClientOptions) {
    const token = options.token.trim();
    if (!token) throw new Error("Revisor workflow token is required");
    this.excubitor = options.excubitor;
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listProducts(): Promise<readonly RevisorTestWorkflowProduct[]> {
    const service = await this.excubitor.findService(REVISOR_SERVICE_CODE);
    const port = service?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}/v1/test-workflow`,
        {
          headers: {
            authorization: `Bearer ${this.token}`,
            "x-concordia-actor": "concordia",
          },
          signal: controller.signal,
        },
      );
      const body = await response.json().catch(() => null) as {
        products?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor test workflow request failed (${response.status})${detail}`);
      }
      const products = body?.products;
      if (!Array.isArray(products) || !products.every(isProduct)) {
        throw new Error("Revisor returned an invalid test workflow response");
      }
      return products;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRevisorTestWorkflowClientFromEnv(
  excubitor: Pick<ExcubitorClient, "findService">,
  env: NodeJS.ProcessEnv = process.env,
): RevisorTestWorkflowClient | null {
  const token = env.CONCORDIA_REVISOR_WORKFLOW_TOKEN?.trim();
  return token ? new RevisorTestWorkflowClient({ excubitor, token }) : null;
}
