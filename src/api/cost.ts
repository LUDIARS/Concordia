/**
 * /v1/cost — WebUI の /cost ページ用の自セッションコスト API。
 *
 * クロスサービス feed (/v1/cost-feed) とは別系統で、 Concordia 自身が回している
 * セッションの使用量を出す:
 *   GET /v1/cost/overview     本社/子会社別 (日次・週間) + チャンネル別 (現在の context/cost)
 *                             = Discord の「Concordia Monitor」「コスト」チャンネルと同じ内容
 *   GET /v1/cost/timeseries   10 分毎サンプルを時刻バケットに畳んだ折れ線グラフ用系列
 *
 * SRP: HTTP routing のみ。 集計は cost/org-cost・channel-cost・usage-timeseries。
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { CostUsageSamplesRepo } from "../db/cost-usage-samples-repo.js";
import { collectOrgCostWindows, type OrgCostSubsidiary } from "../cost/org-cost.js";
import { collectChannelCostRows } from "../cost/channel-cost.js";
import { aggregateUsageTimeseries } from "../cost/usage-timeseries.js";

export interface CostApiDeps {
  sessions: SessionsRepo;
  channels: DiscordSessionChannelsRepo;
  samples: CostUsageSamplesRepo;
  /** 本社モニターと同じ子会社一覧 (本社=未タグは内部で算出)。 */
  listSubsidiaries: () => OrgCostSubsidiary[];
}

export function costRouter(deps: CostApiDeps): Hono {
  const app = new Hono();

  app.get("/overview", (c) => {
    const subs = deps.listSubsidiaries();
    const windows = collectOrgCostWindows(deps.sessions, subs);
    const active = deps.sessions.listSessions({ status: "active" });
    const channelOf = (sid: string): string | null =>
      deps.channels.findBySessionId(sid)?.channel_id ?? null;
    const channels = collectChannelCostRows(active, channelOf);
    return c.json({ windows, channels });
  });

  app.get("/timeseries", (c) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceQ = Number(c.req.query("since"));
    const bucketQ = Number(c.req.query("bucket"));
    // 既定: 直近 24h・10 分バケット。 since は epoch 秒 (0 = 全期間)。 未指定/NaN は 24h 前。
    const sinceSec = Number.isFinite(sinceQ) && sinceQ >= 0 ? Math.floor(sinceQ) : nowSec - 24 * 3600;
    const bucketSec = Number.isFinite(bucketQ) && bucketQ > 0 ? Math.floor(bucketQ) : 600;
    const rows = deps.samples.listSince(sinceSec);
    return c.json(aggregateUsageTimeseries(rows, bucketSec));
  });

  return app;
}
