/**
 * バグバウンティの HTTP ルートをまとめてマウントする (spec/feature/bug-bounty.md §3 §5 §7 §8 §8.2)。
 * register-core は受付と後続の deps を渡すだけにし、ルートの並びはここが持つ。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-WEBUI
 * @implements SPEC-BOUNTY-PUBLIC
 */

import type { Hono } from "hono";
import type { BountyIntakeService } from "../bounty/intake-service.js";
import { bountyActionsRouter, type BountyActionsApiDeps } from "./bounty-actions.js";
import type { BountyOperatorVerifier } from "./bounty-actor.js";
import { bountyAdminActionsRouter, bountyAdminReadRouter, type BountyAdminApiDeps } from "./bounty-admin.js";
import { bountyEventsAdminRouter, bountyEventsReadRouter, type BountyEventsApiDeps } from "./bounty-events.js";
import { bountyPublicRouter, publicIssuesProjectsRouter, type BountyPublicApiDeps } from "./bounty-public.js";
import { bountyRouter } from "./bounty.js";

/** 受付より後段 (仕分け・再審・修正・反映確認・管理面・公開面)。 */
export type BountyFlowRoutesDeps =
  & Omit<BountyActionsApiDeps, "verifyOperator">
  & Omit<BountyAdminApiDeps, "judgement" | "fix" | "close">
  & { fix: BountyAdminApiDeps["fix"] }
  & Omit<BountyPublicApiDeps, "reports" | "reporters">
  & Partial<BountyEventsApiDeps>;

export function mountBountyRoutes(app: Hono, deps: {
  intake: BountyIntakeService;
  verifyOperator?: BountyOperatorVerifier;
  flow?: BountyFlowRoutesDeps;
}): void {
  app.route("/v1/bounty", bountyRouter({ intake: deps.intake, ...(deps.verifyOperator ? { verifyOperator: deps.verifyOperator } : {}) }));
  const flow = deps.flow;
  if (!flow) return;
  app.route("/v1/bounty", bountyActionsRouter({ ...flow, ...(deps.verifyOperator ? { verifyOperator: deps.verifyOperator } : {}) }));
  app.route("/v1/bounty", bountyAdminReadRouter(flow));
  app.route("/v1/bounty", bountyPublicRouter(flow));
  app.route("/v1/projects", publicIssuesProjectsRouter(flow));
  app.route("/v1/admin/bounty", bountyAdminActionsRouter(flow));
  // 企画 (§0 §18.3)。 読み出しは報告の一覧と同じ配下、書き込みは admin の配下。
  if (flow.events) {
    app.route("/v1/bounty", bountyEventsReadRouter({ events: flow.events }));
    app.route("/v1/admin/bounty", bountyEventsAdminRouter({ events: flow.events }));
  }
}
