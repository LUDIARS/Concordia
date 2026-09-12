/** @implements spec/feature/project-created-notify.md — 新規プロジェクトの本社通知 */

export interface ProjectCreatedEvent {
  /** owner/name に正規化した GitHub リポジトリ。 */
  repository: string;
  /** LUDIARS 通しコード (略称)。 */
  code: string;
  project: string;
  repoUrl: string;
}

export interface ProjectNoticeLedger {
  /** 登録時に「未通知」として控える。既に控えてあれば false。 */
  arm(event: ProjectCreatedEvent, now: number): boolean;
  /** 未通知の控えを 1 つだけ確定させる。他が先に取っていれば null。 */
  claim(repository: string, now: number): ProjectCreatedEvent | null;
}

export interface ProjectNoticeDelivery {
  ccChannel(content: string): Promise<void>;
}

export interface ProjectNoticeOutcome {
  /** 控えが無い (既に通知済み、または arm されていないリポ)。 */
  skipped: boolean;
  unconfigured: boolean;
  delivered: boolean;
  failed: string | null;
}

/**
 * 本社チャンネルに出す本文。リリース通知と同じ 1 行目の型に揃え、
 * 公開・非公開で文面を変えない (本社内は全件通知)。
 */
export function composeProjectCreatedNotice(event: ProjectCreatedEvent): string {
  return [`【${event.repository} 新規プロジェクト】 ${event.code} ${event.project}`, event.repoUrl.trim()]
    .filter(Boolean)
    .join("\n");
}

/**
 * 初回 push の時点で、控えを 1 つだけ確定させてから外部配送を試みる。
 * 配送に失敗しても控えは戻さない。push を止めないための境界であり、
 * 失敗は呼び出し元がログで観測する。
 */
export async function handleProjectPushed(input: {
  repository: string;
  ledger: ProjectNoticeLedger;
  channelConfigured: boolean;
  delivery: ProjectNoticeDelivery;
  now: number;
}): Promise<ProjectNoticeOutcome> {
  const event = input.ledger.claim(input.repository, input.now);
  if (!event) return { skipped: true, unconfigured: false, delivered: false, failed: null };
  if (!input.channelConfigured) return { skipped: false, unconfigured: true, delivered: false, failed: null };
  try {
    await input.delivery.ccChannel(composeProjectCreatedNotice(event));
    return { skipped: false, unconfigured: false, delivered: true, failed: null };
  } catch (error) {
    return {
      skipped: false,
      unconfigured: false,
      delivered: false,
      failed: error instanceof Error ? error.message : "project created notification delivery failed",
    };
  }
}
