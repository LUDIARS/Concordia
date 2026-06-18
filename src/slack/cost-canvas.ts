/**
 * Slack の「コスト」Canvas を作成・更新する。
 *
 * Discord の cost チャンネル (discord/cost-channel.ts) と同じ集計・同じ本文
 * (cost/cost-report.ts) を Slack Canvas に描く。 Canvas は「作って終わり」ではなく
 * **canvas_id を slack_config に保存して毎回 edit で上書き**する (= 親 (= Canvas) の id を
 * 持っておいてあとから編集する方式)。 Canvas が削除された等で edit が失敗したら id を
 * 捨てて次サイクルに作り直す。
 *
 * Slack の Canvas は Discord の `<t:..>` タイムスタンプトークンを解さないので、
 * タイムスタンプは JST の素テキストで描く ({@link SLACK_TS_FORMAT})。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import {
  collectCostReport,
  renderCostReportMarkdown,
  type CostTimestampFormat,
} from "../cost/cost-report.js";

/** slack_config に canvas_id を保存するキー。 */
export const COST_CANVAS_KEY = "cost_canvas_id";

/** Canvas のタイトル。 */
export const COST_CANVAS_TITLE = "コスト";

/** Canvas の markdown ドキュメント (Slack canvases API の document_content)。 */
interface CanvasDocument {
  type: "markdown";
  markdown: string;
}

/** Canvas 全体を新 markdown で置き換える 1 操作。 */
interface CanvasReplaceChange {
  operation: "replace";
  document_content: CanvasDocument;
}

/**
 * cost-canvas が必要とする Slack Web API の最小サブセット。
 * 本番は WebClient を薄くラップして渡し、 test は fake を渡す (SRP / 注入)。
 */
export interface CostCanvasClient {
  canvases: {
    edit(args: { canvas_id: string; changes: [CanvasReplaceChange] }): Promise<{ ok?: boolean }>;
  };
  conversations: {
    canvases: {
      create(args: {
        channel_id: string;
        title?: string;
        document_content: CanvasDocument;
      }): Promise<{ canvas_id?: string; ok?: boolean }>;
    };
  };
}

/** Slack 用タイムスタンプ表現: JST の素テキスト (`<t:..>` トークンは Canvas で展開されない)。 */
export const SLACK_TS_FORMAT: CostTimestampFormat = {
  updated: (nowSec) => formatJst(nowSec),
  at: (epochSec) => (epochSec === null ? "-" : formatJst(epochSec)),
};

const JST_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatJst(epochSec: number): string {
  return `${JST_FORMATTER.format(new Date(epochSec * 1000))} JST`;
}

export interface UpsertCostCanvasDeps {
  client: CostCanvasClient;
  channelId: string;
  sessionsRepo: SessionsRepo;
  configGet: (k: string) => string | null;
  configSet: (k: string, v: string) => void;
  configDelete: (k: string) => void;
  /** test 用の時刻注入 (既定は new Date())。 */
  now?: () => Date;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * cost Canvas を「あれば edit / 無ければ作成」で最新化する。
 * Discord と同一の集計・本文を使い、 canvas_id を slack_config に永続化する。
 */
export async function upsertCostCanvas(deps: UpsertCostCanvasDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const report = await collectCostReport(deps.sessionsRepo, { oauthLog: deps.log });
  const markdown = renderCostReportMarkdown(report, SLACK_TS_FORMAT, nowSec);
  await applyCostCanvas(markdown, deps);
}

/** 既に組んだ markdown を Canvas に反映する。 集計と分離 (test 容易性 / SRP)。 */
export async function applyCostCanvas(
  markdown: string,
  deps: Pick<
    UpsertCostCanvasDeps,
    "client" | "channelId" | "configGet" | "configSet" | "configDelete" | "log"
  >,
): Promise<void> {
  const stored = deps.configGet(COST_CANVAS_KEY);
  if (stored) {
    try {
      await deps.client.canvases.edit({
        canvas_id: stored,
        changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
      });
      return;
    } catch (e) {
      // Canvas が消えた / id 失効 → 保存 id を捨てて作り直しにフォールバック。
      deps.log?.warn(`cost canvas edit failed (id=${stored}); recreate: ${(e as Error).message}`);
      deps.configDelete(COST_CANVAS_KEY);
    }
  }

  try {
    const r = await deps.client.conversations.canvases.create({
      channel_id: deps.channelId,
      title: COST_CANVAS_TITLE,
      document_content: { type: "markdown", markdown },
    });
    const id = r.canvas_id;
    if (id) {
      deps.configSet(COST_CANVAS_KEY, id);
      deps.log?.info(`cost canvas created id=${id} channel=${deps.channelId}`);
    } else {
      deps.log?.warn("cost canvas create returned no canvas_id");
    }
  } catch (e) {
    deps.log?.warn(`cost canvas create failed: ${(e as Error).message}`);
  }
}
