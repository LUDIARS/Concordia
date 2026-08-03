// Revisor Test Workflow の読取クライアント (spec/feature/revisor-test-forum-sync.md)。
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { toTokenResolver } from "./revisor-token.js";

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

export interface RevisorTestWorkflowClientOptions {
  excubitor: Pick<ExcubitorClient, "findService">;
  /**
   * 読み取りは loopback 限定で token 不要。 設定されている場合だけ Bearer を送る。
   * 関数を渡すとリクエストごとに解決する (設定変更が再起動なしで効く)。
   */
  token?: string | (() => string | undefined);
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
  private readonly token: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RevisorTestWorkflowClientOptions) {
    // Revisor は loopback からの読み取りに token を要求しない (変更系のみ要求する)。
    // token は「あれば送る」扱いにして、 設定が無いだけで一覧取得が止まらないようにする。
    this.excubitor = options.excubitor;
    this.token = toTokenResolver(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listProducts(): Promise<readonly RevisorTestWorkflowProduct[]> {
    const service = await this.excubitor.findService(REVISOR_SERVICE_CODE);
    // Excubitor の top-level port は実行時の観測値で null のことがある。 catalog が正本。
    const port = resolveServicePort(service);
    if (port === null) {
      throw new Error(`Excubitor service "${REVISOR_SERVICE_CODE}" has no valid port`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // token は保持せずリクエストごとに解決する (設定変更が再起動なしで効く)。
      // resolver は DB を読むので throw しうる。 try の中で呼び、 timer を必ず片付ける。
      const token = this.token();
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}/v1/test-workflow`,
        {
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
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
): RevisorTestWorkflowClient {
  // Revisor の読み取りは loopback 限定で token 不要なので、 未設定でもクライアントを作る。
  // これが null を返していたため、 token を配れないだけで Test Forum 同期が
  // 「Revisor Test Workflow source unavailable」で永久にスキップされていた。
  // trim は constructor 側で行う。
  return new RevisorTestWorkflowClient({
    excubitor,
    token: env.CONCORDIA_REVISOR_WORKFLOW_TOKEN,
  });
}

/**
 * DB 設定 (revisor_config) 込みで token を解決するクライアント。
 * `resolveToken` はリクエストごとに呼ばれるので、 Web UI での変更が再起動なしで効く。
 */
export function createRevisorTestWorkflowClient(
  excubitor: Pick<ExcubitorClient, "findService">,
  resolveToken: () => string | undefined,
  // fetch / timeout はテストから差し替えられるようにしておく (省略時は既定)。
  overrides: Pick<RevisorTestWorkflowClientOptions, "fetchImpl" | "timeoutMs"> = {},
): RevisorTestWorkflowClient {
  return new RevisorTestWorkflowClient({ excubitor, token: resolveToken, ...overrides });
}
