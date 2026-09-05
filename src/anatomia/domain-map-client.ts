/**
 * src/anatomia/domain-map-client.ts — warm Anatomia server の読み取りクライアント。
 *
 * 委託の指示書を作る前に「どのプロダクトの、どのコアドメインの話か」を確定するための
 * 2 本を叩く (設計 §12.3 C-11 / §5 C-2):
 *
 *   GET  /api/domain-map/search?q=<指示文>   横断ドメインマップ検索 (ミリ秒級・LLM 不要)
 *   POST /api/plan { project, task, okf }    ドメイン計画を OKF ドキュメントで受け取る
 *
 * **best-effort**: Anatomia が落ちている / 索引に無い / 応答が遅い場合は null を返す。
 * 委託そのものは決して止めない (設計 §5 の 4 点目)。 node:http + keep-alive off +
 * 短いタイムアウトで、 遅いサーバが invoke を待たせないようにする (cache-stats-client と同じ作法)。
 *
 * SRP: HTTP 取得と形の絞り込みだけ。 プロンプトの組み立ては delegation/domain-preamble.ts。
 *
 * @implements SPEC-DELEGATION-DOMAIN-PREAMBLE
 */

import { request } from "node:http";

/** 1 検索ヒット (Anatomia `DomainMapHit` の必要分)。 */
export interface DomainMapSearchHit {
  project: string;
  kind: string;
  name: string;
  coreDomain: string | null;
  programDomains: string[];
  paths: string[];
  spec: string | null;
  score: number;
}

export interface DomainMapSearchResult {
  query: string;
  hits: DomainMapSearchHit[];
}

/** Base URL of the warm Anatomia server (ANATOMIA_PORT, default 4200). */
function baseUrl(): string {
  const port = process.env.ANATOMIA_PORT || "4200";
  return `http://127.0.0.1:${port}`;
}

interface HttpOptions {
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: string;
}

/** 壊れた loopback peer が無制限の JSON を返して委託プロセスを圧迫しない上限。 */
const MAX_RESPONSE_CHARS = 1_000_000;

/** 1 リクエスト。 失敗 (接続不能 / 非 2xx / タイムアウト / 壊れた JSON) は必ず null。 */
function fetchJson(path: string, opts: HttpOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: unknown) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    try {
      const url = new URL(`${baseUrl()}${path}`);
      const headers: Record<string, string> = { accept: "application/json" };
      if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(opts.body, "utf8"));
      }
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: opts.method ?? "GET",
          headers,
          agent: false,
        },
        (res) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return finish(null);
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (done) return;
            data += chunk;
            if (data.length > MAX_RESPONSE_CHARS) {
              req.destroy();
              finish(null);
            }
          });
          res.on("end", () => {
            try {
              finish(JSON.parse(data) as unknown);
            } catch {
              finish(null);
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => { req.destroy(); finish(null); });
      req.on("error", () => finish(null));
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    } catch {
      finish(null);
    }
  });
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * 横断ドメインマップ検索。 サーバが居ない / manager モードでない場合は null。
 * 0 件ヒットは `hits: []` を返す (「索引に無い」ことを呼び出し側が書けるようにする)。
 */
export async function searchDomainMap(
  query: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<DomainMapSearchResult | null> {
  const q = query.trim();
  if (!q) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const json = await fetchJson(
    `/api/domain-map/search?q=${encodeURIComponent(q.slice(0, 2000))}&limit=${limit}`,
    { timeoutMs: opts.timeoutMs ?? 2000 },
  );
  if (!json || typeof json !== "object") return null;
  const body = json as { query?: unknown; hits?: unknown };
  if (!Array.isArray(body.hits)) return null;
  const hits: DomainMapSearchHit[] = [];
  for (const raw of body.hits) {
    if (!raw || typeof raw !== "object") continue;
    const hit = raw as Record<string, unknown>;
    hits.push({
      project: str(hit.project),
      kind: str(hit.kind),
      name: str(hit.name),
      coreDomain: typeof hit.coreDomain === "string" ? hit.coreDomain : null,
      programDomains: strList(hit.programDomains),
      paths: strList(hit.paths),
      spec: typeof hit.spec === "string" ? hit.spec : null,
      score: typeof hit.score === "number" ? hit.score : 0,
    });
  }
  return { query: str(body.query) || q, hits };
}

/**
 * ドメイン計画を OKF ドキュメントで受け取る (`plan --format okf` と同じ出力)。
 *
 * `llm: false` で呼ぶ — 委託 1 回ごとに LLM 分解 (~10s) を待たせないため。 決定的な
 * 分解でも OKF frontmatter (service / domain / tags) と各ドメインの description・
 * membership・dataDefs は揃う。 ドメイン定義が無いリポでは null を返す。
 */
export async function fetchPlanOkf(
  project: string,
  task: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const id = project.trim();
  const body = task.trim();
  if (!id || !body) return null;
  const json = await fetchJson("/api/plan", {
    method: "POST",
    timeoutMs: opts.timeoutMs ?? 8000,
    body: JSON.stringify({ project: id, task: body.slice(0, 4000), llm: false, map: false, okf: true }),
  });
  if (!json || typeof json !== "object") return null;
  const okf = (json as { okf?: unknown }).okf;
  return typeof okf === "string" && okf.trim() ? okf : null;
}
