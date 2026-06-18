/**
 * src/cost/cost-feed.ts — Cross-service LLM cost feed (ingest store).
 *
 * このモジュールは Anatomia の cost-feed パネルを Concordia 側にも複製したもの
 * (正本は Anatomia/src/cost/feed.ts)。他の LUDIARS サービス (Discutere, …) は
 * 同じコスト要約を Anatomia と Concordia の両方へ PUSH することがある
 * (POST /v1/cost-feed)。受け取った行は web の「LLM Cost (cross-service)」
 * パネルにそのまま並べる。
 *
 * ⚠ ここで扱うのは「他サービスから push された横断コスト」であって、
 * Concordia 自身の CLI セッション使用量 (usage-tracker.ts / cost-report.ts) とは
 * 別系統。混同しないこと。
 *
 * 各行は per-(session × model × backend) の要約。サービスは議論の進行に応じて
 * 同じ session を再 push しうるので、集計は key ごとに LATEST 行を採用する
 * (cost-feed-aggregate.ts 参照)。重複加算はしない。
 *
 * 保管は append-only JSONL を CONCORDIA_COST_FEED_LOG で gate する
 * (cross-process の ground truth)。env 未設定なら in-memory バッファに退避し、
 * 単一プロセス内では dev パネルが動く。
 *
 * SRP: entry 形状 + JSONL append/read + env 解決のみ。
 * 集計は cost-feed-aggregate.ts、HTTP routing は api/cost-feed.ts。
 */

import { appendFile, readFile } from "node:fs/promises";

/** サービスが push する per-(session × model × backend) コスト要約 1 件。 */
export interface CostFeedEntry {
  /** この要約を生成した時刻 (epoch ms)。key ごとに latest が勝つ。 */
  ts: number;
  /** 送信元サービス。例 "discutere"。 */
  service: string;
  /** 送信元サービス自身の session/discussion id。 */
  sessionId: string;
  model?: string;
  backend?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * 推定コスト (USD)。サブスク (claude-cli) は等価 API 価格の推定であり実課金
   * ではない。usage-metered backend は 0 を返すことがある。
   */
  costUsd: number;
}

/** cost-feed entry の sink + reader。`record` は fire-and-forget。 */
export interface CostFeed {
  record(entry: CostFeedEntry): void;
  read(): Promise<CostFeedEntry[]>;
  /** queue 済みの書き込みが全て flush されたら resolve。 */
  flush(): Promise<void>;
}

/** in-memory feed (プロセス寿命)。CONCORDIA_COST_FEED_LOG 未設定時に使う。 */
export function createMemoryCostFeed(): CostFeed {
  const buf: CostFeedEntry[] = [];
  return {
    record(e) {
      buf.push(e);
    },
    async read() {
      return buf.slice();
    },
    async flush() {
      /* queue なし */
    },
  };
}

/** JSONL-backed feed: 1 entry = 1 行 append、read で parse して読み戻す。 */
export function createJsonlCostFeed(path: string): CostFeed {
  let queue: Promise<void> = Promise.resolve();
  return {
    record(e) {
      const line = JSON.stringify(e) + "\n";
      queue = queue.then(() => appendFile(path, line, "utf8").catch(() => undefined));
    },
    async read() {
      return readCostEntries(path);
    },
    async flush() {
      await queue;
    },
  };
}

/** cost-feed JSONL を read + parse。壊れた行は skip し、fatal にしない。 */
export async function readCostEntries(path: string): Promise<CostFeedEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: CostFeedEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as CostFeedEntry;
      if (o && typeof o.service === "string" && typeof o.sessionId === "string") out.push(o);
    } catch {
      // parse 不能 / 書き込み途中の行は skip
    }
  }
  return out;
}

let singleton: CostFeed | null = null;

/**
 * env から解決するプロセス共通の cost feed。
 * CONCORDIA_COST_FEED_LOG = JSONL ファイルパス (cross-process)、未設定なら in-memory。
 */
export function getCostFeed(): CostFeed {
  if (singleton) return singleton;
  const logPath = process.env["CONCORDIA_COST_FEED_LOG"];
  singleton =
    logPath && logPath.trim() ? createJsonlCostFeed(logPath.trim()) : createMemoryCostFeed();
  return singleton;
}

/** テスト用: cache した singleton を破棄し、次の getCostFeed() で再解決させる。 */
export function _resetCostFeed(): void {
  singleton = null;
}
