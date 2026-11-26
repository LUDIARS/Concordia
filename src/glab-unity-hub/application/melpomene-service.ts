/**
 * Melpomene のバグ報告の受け口 (契約 v1 §4a Hub 側)。
 *
 * HTTP (ログ付き) と WS `melpomene.report` (ログ無し・本文のみ) の両方がここを通る。
 * repo は許可リストだけ。 ログはバグ報告チャンネルへ添付で上げ、 その URL を Issue 本文に書く。
 *
 * @implements spec/feature/glab-unity-hub.md §4a (GUH-MELPOMENE)
 */

import { HubError } from "../domain/protocol.js";
import { checkReport, composeIssueBody, safeLabels } from "../domain/melpomene-report.js";
import type { HubIdentity } from "./authenticate.js";
import type { AuditLog, DiscordGateway, IssuePort } from "./ports.js";
import type { MethodContext } from "./method-context.js";
import type { HubPayload } from "../domain/methods.js";

export interface MelpomeneServiceDeps {
  readonly github: IssuePort;
  readonly discord: Pick<DiscordGateway, "uploadLogs">;
  readonly audit: AuditLog;
  readonly allowedRepos: readonly string[];
}

export interface MelpomeneReceipt {
  readonly issueUrl: string;
  readonly logUrls: string[];
}

export class HubMelpomeneService {
  constructor(private readonly deps: MelpomeneServiceDeps) {}

  /** HTTP の本文 (JSON を読んだ値) を受ける。 */
  async submit(identity: HubIdentity, body: unknown): Promise<MelpomeneReceipt> {
    const check = checkReport(body, this.deps.allowedRepos);
    if (!check.ok) throw new HubError(check.code, check.message);
    const uploaded = check.logs.length > 0
      ? await this.deps.discord.uploadLogs({ title: check.report.title, reporter: identity.member, files: check.logs })
      : [];
    const issueUrl = await this.deps.github.createIssue({
      repo: check.report.repo,
      title: check.report.title,
      body: composeIssueBody({
        report: check.report,
        reporterName: identity.member.displayName,
        reporterDiscordUserId: identity.member.discordUserId,
        logUrls: uploaded,
      }),
      labels: safeLabels(check.report.labels),
    });
    this.deps.audit.record({
      kind: "operation", tokenId: identity.token.id, discordUserId: identity.token.discordUserId, country: null, ip: null,
      operation: "melpomene.report", result: "ok", detail: `${check.report.repo} logs=${uploaded.length}`,
    });
    return { issueUrl, logUrls: uploaded.map((log) => log.url) };
  }

  /** WS の `melpomene.report` (ログ無し)。 */
  async report(context: MethodContext, payload: HubPayload<"melpomene.report">): Promise<MelpomeneReceipt> {
    return this.submit(context.identity, { ...payload, logs: [] });
  }
}
