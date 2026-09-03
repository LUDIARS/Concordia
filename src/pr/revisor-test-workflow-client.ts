// Revisor Test Workflow の読取クライアント。
// @implements spec/feature/revisor-test-forum-sync.md — Runtime boundary
import type { ExcubitorClient } from "../excubitor/client.js";
import { resolveServicePort } from "../excubitor/service-port.js";
import { SharedReadCache } from "./revisor-read-cache.js";
import { toTokenResolver } from "./revisor-token.js";

const REVISOR_SERVICE_CODE = "revisor";
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * 一覧系 GET の再利用時間。 test-forum の定期 reconcile は Discord client (本社 +
 * 子会社) ごとに走り、 ほぼ同時刻に同じ一覧を何度も取りに行く。 短い TTL でその束を
 * 1 回に畳む。 即時性が要る PR 状態変化は {@link RevisorTestWorkflowClient.invalidateReads}
 * で明示的に捨てるので、 TTL を延ばして鮮度を落とす必要はない。
 */
const DEFAULT_READ_CACHE_TTL_MS = 5_000;
/** キャッシュキー。 Revisor の path と Excubitor の catalog 引きを 1 つの cache に載せる。 */
const SERVICE_LOOKUP_CACHE_KEY = `service:${REVISOR_SERVICE_CODE}`;

export interface RevisorTestWorkflowProduct {
  repository: string;
  pullRequestId: string;
  number: number;
  title: string;
  status: "Open / Test OK";
  headRef: string;
  repositoryRootPath: string;
  reviewedHeadSha: string;
  updatedAt: string;
}

/**
 * Test Forum の投稿に載せる PR の詳細と判断事項。 Revisor の
 * `GET /v1/local-prs/:id` (loopback 読み取り) の decision 部分の抜粋。
 */
export interface RevisorLocalPrDetail {
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  body: string | null;
  decisionState: string | null;
  decisionLabel: string | null;
  /** 現在の base に対して競合なくマージできるか。 */
  mergeable: boolean;
  /** 人間の判断が必要な理由 (判断事項)。 */
  blockers: readonly string[];
  riskScore: number | null;
  riskThreshold: number | null;
  riskBandLabel: string | null;
  runtimeVerificationRequired: boolean;
  /** 登録テストの通過数 / 実行数 (skip 除く)。 */
  testsPassed: number | null;
  testsRan: number | null;
  /** 審査失敗時に Test Forum へ載せられる、Revisor 側でマスク済みの失敗証跡。 */
  failedTests: readonly RevisorFailedTest[];
  reviewError: string | null;
  securityStatus: string | null;
  autoMerge: { merged: boolean; reason: string } | null;
}

export interface RevisorFailedTest {
  name: string;
  exitCode: number | null;
  reason: string | null;
  output: { text: string; truncated: boolean } | null;
}

/**
 * Test Forum に掲載する open な local PR。 審査済み (Test OK) に限らず、
 * Revisor に登録された時点から失敗・判断待ち・審査中も全部載せる。
 */
export interface RevisorOpenLocalPr {
  id: string;
  repository: string;
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  reviewedHeadSha: string | null;
  repositoryRootPath: string;
  checkStatus: string;
  /** 提出元 Concordia セッション。 メンション対象の解決に使う。 */
  sessionId: string | null;
  detail: RevisorLocalPrDetail;
}

/** Test Forum の終局投稿に使う、Revisor で決着済みの local PR。 */
export interface RevisorTerminalLocalPr {
  repository: string;
  number: number;
  status: "merged" | "closed";
  mergeCommitSha: string | null;
}

export interface RevisorTestWorkflowSource {
  listProducts(): Promise<readonly RevisorTestWorkflowProduct[]>;
  /** open な local PR の全件 (詳細・spawn target 込み)。 Test Forum の候補正本。 */
  listOpenLocalPrs(): Promise<readonly RevisorOpenLocalPr[]>;
  /**
   * 掲載済みスレッドの終局理由を解決するための merged / closed PR 一覧。
   * 実装されない source でも、従来どおり候補から消えた投稿を閉じられる。
   */
  listTerminalLocalPrs?(): Promise<readonly RevisorTerminalLocalPr[]>;
  /**
   * 単一 PR の詳細。 取得や解析に失敗しても同期全体は止めない前提の
   * 追加情報なので、 呼出側は失敗を null として扱ってよい (throw はする)。
   */
  getProductDetail(pullRequestId: string): Promise<RevisorLocalPrDetail>;
  /**
   * 一覧の読み取りキャッシュを捨てる。 実装は任意 (キャッシュを持たない source もある)。
   * 呼出側は「今すぐ取り直してほしい」契機でだけ呼ぶ。同じ契機を複数 runtime が共有する
   * 場合は、同じ object を渡すと重複した無効化を避けられる。
   */
  invalidateReads?(cause?: object): void;
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
  /** 一覧系 GET の再利用時間 (ms)。 既定 {@link DEFAULT_READ_CACHE_TTL_MS}。 */
  readCacheTtlMs?: number;
  /** epoch-ms クロック (テスト用)。 既定 Date.now。 */
  now?: () => number;
}

interface RevisorTestWorkflowProjection {
  repository: string;
  pullRequestId: string;
  number: number;
  title: string;
  status: "Open / Test OK";
  reviewedHeadSha: string;
  updatedAt: string;
}

function isProjection(value: unknown): value is RevisorTestWorkflowProjection {
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class RevisorTestWorkflowClient implements RevisorTestWorkflowSource {
  private readonly excubitor: Pick<ExcubitorClient, "findService">;
  private readonly token: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly reads: SharedReadCache;
  private readonly invalidationCauses = new WeakSet<object>();

  constructor(options: RevisorTestWorkflowClientOptions) {
    // Revisor は loopback からの読み取りに token を要求しない (変更系のみ要求する)。
    // token は「あれば送る」扱いにして、 設定が無いだけで一覧取得が止まらないようにする。
    this.excubitor = options.excubitor;
    this.token = toTokenResolver(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reads = new SharedReadCache({
      ttlMs: options.readCacheTtlMs ?? DEFAULT_READ_CACHE_TTL_MS,
      now: options.now,
    });
  }

  /**
   * 一覧系の読み取りキャッシュを捨てる。
   *
   * PR 状態変化の通知など「取り直した結果を今すぐ見せる」契機で呼ぶ。 定期 reconcile と
   * 違って鮮度が意味を持つ経路なので、 TTL の残りを待たせない。
   */
  invalidateReads(cause?: object): void {
    // 本社・子会社 runtime は同じ event object とこの client を共有する。各 listener が
    // 順番に invalidate すると、直前の listener が開始した single-flight まで消して
    // client 数ぶん再取得してしまうため、同じ契機は一度だけ適用する。
    if (cause) {
      if (this.invalidationCauses.has(cause)) return;
      this.invalidationCauses.add(cause);
    }
    this.reads.invalidate();
  }

  async listProducts(): Promise<readonly RevisorTestWorkflowProduct[]> {
    const [workflowBody, prsBody, repositoriesBody] = await Promise.all([
      this.getListJson("/v1/test-workflow"),
      this.getListJson("/v1/local-prs"),
      this.getListJson("/v1/repositories"),
    ]) as Array<Record<string, unknown> | null>;
    const rawProducts = workflowBody?.products;
    const pullRequests = prsBody?.pullRequests;
    const repositories = repositoriesBody?.repositories;
    if (
      !Array.isArray(rawProducts)
      || !Array.isArray(pullRequests)
      || !Array.isArray(repositories)
    ) {
      throw new Error("Revisor returned an invalid test workflow response");
    }
    // Revisor は early QA (feat 697a730) で審査中の行 (Open / In Review,
    // reviewedHeadSha null) も返すようになった。 listProducts の意味は
    // 「Test OK のプロダクト」なので、 早期 QA 行は捨てて Test OK だけを検証する。
    const products = rawProducts.filter((value) =>
      !!value && typeof value === "object"
      && (value as Record<string, unknown>).status === "Open / Test OK");
    if (!products.every(isProjection)) {
      throw new Error("Revisor returned an invalid test workflow response");
    }
    return products.map((product) => {
      const pullRequest = pullRequests.find((value) => {
        if (!value || typeof value !== "object") return false;
        const candidate = value as Record<string, unknown>;
        return candidate.id === product.pullRequestId
          && candidate.repository === product.repository;
      }) as Record<string, unknown> | undefined;
      const repository = repositories.find((value) => {
        if (!value || typeof value !== "object") return false;
        return (value as Record<string, unknown>).repository === product.repository;
      }) as Record<string, unknown> | undefined;
      if (!nonEmptyString(pullRequest?.headRef) || !nonEmptyString(repository?.rootPath)) {
        throw new Error(`Revisor omitted the spawn target for ${product.repository}#${product.number}`);
      }
      return {
        ...product,
        headRef: pullRequest.headRef,
        repositoryRootPath: repository.rootPath,
      };
    });
  }

  async listOpenLocalPrs(): Promise<readonly RevisorOpenLocalPr[]> {
    const [prsBody, repositoriesBody] = await Promise.all([
      this.getListJson("/v1/local-prs"),
      this.getListJson("/v1/repositories"),
    ]) as Array<Record<string, unknown> | null>;
    const rows = prsBody?.pullRequests;
    const repositories = repositoriesBody?.repositories;
    if (!Array.isArray(rows) || !Array.isArray(repositories)) {
      throw new Error("Revisor returned an invalid local PR list response");
    }
    const rootPaths = new Map<string, string>();
    for (const value of repositories) {
      if (!value || typeof value !== "object") continue;
      const repository = value as Record<string, unknown>;
      if (nonEmptyString(repository.repository) && nonEmptyString(repository.rootPath)) {
        rootPaths.set(repository.repository, repository.rootPath);
      }
    }
    const open: RevisorOpenLocalPr[] = [];
    for (const row of rows) {
      const parsed = parseOpenLocalPr(row, rootPaths);
      if (parsed) open.push(parsed);
    }
    return open;
  }

  async listTerminalLocalPrs(): Promise<readonly RevisorTerminalLocalPr[]> {
    const body = await this.getListJson("/v1/local-prs") as Record<string, unknown> | null;
    const rows = body?.pullRequests;
    if (!Array.isArray(rows)) {
      throw new Error("Revisor returned an invalid local PR list response");
    }
    const terminal: RevisorTerminalLocalPr[] = [];
    for (const row of rows) {
      const parsed = parseTerminalLocalPr(row);
      if (parsed) terminal.push(parsed);
    }
    return terminal;
  }

  async getProductDetail(pullRequestId: string): Promise<RevisorLocalPrDetail> {
    const body = await this.getJson(
      `/v1/local-prs/${encodeURIComponent(pullRequestId)}`,
    ) as { pullRequest?: unknown } | null;
    const detail = parseLocalPrDetail(body?.pullRequest);
    if (!detail) {
      throw new Error("Revisor returned an invalid local PR detail response");
    }
    return detail;
  }

  /**
   * 一覧系 GET。 同じ path への重複取得を TTL + single-flight で 1 回に畳む。
   *
   * 応答は約 1MB あり、 パースはメインスレッドで走る。 client ごと・用途ごとに
   * 取り直すとイベントループがその回数ぶん止まるため、 一覧はここを通す。
   * 単一 PR の詳細 ({@link getProductDetail}) は鮮度が要るので通さない。
   */
  private getListJson(path: string): Promise<unknown> {
    return this.reads.get(path, () => this.getJson(path));
  }

  private async getJson(path: string): Promise<unknown> {
    // 2 つの upstream (Excubitor catalog → Revisor) を続けて叩くので、素の
    // `fetch failed` だけでは**どちらが落ちているか**分からない。 test-forum reconcile の
    // 失敗ログはこの文言がそのまま出るため、宛先と原因を必ず添えて投げ直す。
    //
    // catalog の port は起動中しか変わらないので、 一覧と同じ TTL で使い回す。
    // 1 回の reconcile で 3 回・client 数ぶん引いていた Excubitor 往復が 1 回になる。
    let service: Awaited<ReturnType<typeof this.excubitor.findService>>;
    try {
      service = await this.reads.get(
        SERVICE_LOOKUP_CACHE_KEY,
        () => this.excubitor.findService(REVISOR_SERVICE_CODE),
      );
    } catch (error) {
      throw new Error(`Excubitor catalog lookup failed for "${REVISOR_SERVICE_CODE}": ${causeOf(error)}`);
    }
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
      let response: Response;
      try {
        response = await this.fetchImpl(
          `http://127.0.0.1:${port}${path}`,
          {
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              "x-concordia-actor": "concordia",
            },
            signal: controller.signal,
          },
        );
      } catch (error) {
        // 接続不能 (Revisor 停止・クラッシュ再起動中) と timeout をここで区別可能にする。
        const reason = controller.signal.aborted ? `timeout after ${this.timeoutMs}ms` : causeOf(error);
        throw new Error(`Revisor request to 127.0.0.1:${port}${path} failed: ${reason}`);
      }
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Revisor test workflow request failed (${response.status})${detail}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `fetch failed` は undici が接続段の失敗をまとめて包む文言で、それ自体では原因が読めない。
 * 下位の cause (ECONNREFUSED 等) があればそれも並べて、ログから一次切り分けできるようにする。
 */
function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  return cause && cause !== message ? `${message} (${cause})` : message;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asGitObjectIdOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(trimmed) ? trimmed : null;
}

/**
 * open 行だけを掲載候補にする。 骨格 (id/repository/番号/head/rootPath) が欠けた行は
 * 候補から外す (null)。 detail の欠落フィールドは parseLocalPrDetail が null へ落とす。
 */
function parseOpenLocalPr(
  value: unknown,
  rootPaths: ReadonlyMap<string, string>,
): RevisorOpenLocalPr | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.status !== "open") return null;
  const rootPath = typeof row.repository === "string" ? rootPaths.get(row.repository) : undefined;
  if (
    !nonEmptyString(row.id)
    || !nonEmptyString(row.repository)
    || typeof row.number !== "number" || !Number.isInteger(row.number)
    || typeof row.title !== "string"
    || !nonEmptyString(row.headRef)
    || !nonEmptyString(row.headSha)
    || !nonEmptyString(row.checkStatus)
    || !rootPath
  ) {
    return null;
  }
  const detail = parseLocalPrDetail(row);
  if (!detail) return null;
  return {
    id: row.id,
    repository: row.repository,
    number: row.number,
    title: row.title,
    headRef: row.headRef,
    headSha: row.headSha,
    reviewedHeadSha: nonEmptyString(row.reviewedHeadSha) ? row.reviewedHeadSha : null,
    repositoryRootPath: rootPath,
    checkStatus: row.checkStatus,
    sessionId: nonEmptyString(row.sessionId) ? row.sessionId : null,
    detail,
  };
}

function parseTerminalLocalPr(value: unknown): RevisorTerminalLocalPr | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    !nonEmptyString(row.repository)
    || typeof row.number !== "number"
    || !Number.isInteger(row.number)
    || row.number <= 0
    || (row.status !== "merged" && row.status !== "closed")
  ) {
    return null;
  }
  return {
    repository: row.repository,
    number: row.number,
    status: row.status,
    mergeCommitSha: asGitObjectIdOrNull(row.mergeCommitSha),
  };
}

/**
 * decision まわりだけを抜粋する寛容なパーサ。 Revisor 側のフィールド追加で
 * 同期を止めないため、 個々の欠落は null に落とす。 ただし PR の骨格
 * (object であること) すら無い場合は null を返し、 呼出側が fail-fast する。
 */
export function parseLocalPrDetail(value: unknown): RevisorLocalPrDetail | null {
  if (!value || typeof value !== "object") return null;
  const pr = value as Record<string, unknown>;
  const decision = (pr.decision && typeof pr.decision === "object"
    ? pr.decision
    : {}) as Record<string, unknown>;
  const blockers = Array.isArray(decision.blockers)
    ? decision.blockers.filter((item): item is string => typeof item === "string")
    : [];
  const ci = Array.isArray(pr.ci) ? pr.ci as Array<Record<string, unknown>> : null;
  const skipped = ci?.filter((entry) => entry.status === "skipped").length ?? 0;
  const failedTests = (ci ?? []).flatMap((entry): RevisorFailedTest[] => {
    if (entry.status !== "failed" || !nonEmptyString(entry.name)) return [];
    const output = entry.output && typeof entry.output === "object"
      ? entry.output as Record<string, unknown>
      : null;
    return [{
      name: entry.name,
      exitCode: asNumberOrNull(entry.exitCode),
      reason: asStringOrNull(entry.reason),
      output: output && typeof output.text === "string"
        ? { text: output.text, truncated: output.truncated === true }
        : null,
    }];
  });
  const security = (pr.security && typeof pr.security === "object"
    ? pr.security
    : null) as Record<string, unknown> | null;
  const autoMerge = (pr.autoMerge && typeof pr.autoMerge === "object"
    ? pr.autoMerge
    : null) as Record<string, unknown> | null;
  return {
    author: asStringOrNull(pr.author),
    headRef: asStringOrNull(pr.headRef),
    baseRef: asStringOrNull(pr.baseRef),
    body: asStringOrNull(pr.body),
    decisionState: asStringOrNull(decision.state),
    decisionLabel: asStringOrNull(decision.label),
    mergeable: decision.mergeable === true,
    blockers,
    riskScore: asNumberOrNull(decision.riskScore),
    riskThreshold: asNumberOrNull(decision.riskThreshold),
    riskBandLabel: asStringOrNull(decision.riskBandLabel),
    runtimeVerificationRequired: decision.runtimeVerificationRequired === true,
    testsPassed: ci ? ci.filter((entry) => entry.status === "passed").length : null,
    testsRan: ci ? ci.length - skipped : null,
    failedTests,
    reviewError: asStringOrNull(pr.error),
    securityStatus: security ? asStringOrNull(security.status) : null,
    autoMerge: autoMerge && typeof autoMerge.merged === "boolean"
      ? { merged: autoMerge.merged, reason: asStringOrNull(autoMerge.reason) ?? "" }
      : null,
  };
}

/**
 * DB 設定 (revisor_config) 込みで token を解決するクライアント。
 * `resolveToken` はリクエストごとに呼ばれるので、 Web UI での変更が再起動なしで効く。
 */
export function createRevisorTestWorkflowClient(
  excubitor: Pick<ExcubitorClient, "findService">,
  resolveToken: () => string | undefined,
  // fetch / timeout / キャッシュはテストから差し替えられるようにしておく (省略時は既定)。
  overrides: Pick<
    RevisorTestWorkflowClientOptions,
    "fetchImpl" | "timeoutMs" | "readCacheTtlMs" | "now"
  > = {},
): RevisorTestWorkflowClient {
  return new RevisorTestWorkflowClient({ excubitor, token: resolveToken, ...overrides });
}
