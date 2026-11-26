/**
 * GLab-UnityHub の use case が外へ出る口 (ports)。 adapter はこの形を実装する。
 *
 * use case は Discord / Notion / Actio / Praeforma / GitHub の具体的な API を知らない。
 * テストはここを偽物に差し替える。
 *
 * @implements spec/feature/glab-unity-hub.md §5 (GUH-ARCH)
 */

import type { StoredToken } from "../domain/token-policy.js";
import type { BoardItem } from "../domain/notion-board.js";
import type { ActioSprintAggregate, SprintTaskRow } from "../domain/sprint-view.js";
import type { CalliopeMaterial, CalliopeProduct } from "../domain/calliope-product.js";
import type { PullRequestEvent, SpecDraftStatus } from "../domain/spec-draft.js";

export interface Clock {
  now(): Date;
}

export interface TokenStore {
  insert(token: StoredToken): void;
  findByHash(hash: string): StoredToken | null;
  listByUser(discordUserId: string): StoredToken[];
  revoke(id: string, at: string): boolean;
  touch(id: string, at: string): void;
  /** `since` より後に失効したトークン id (接続中の WS を切るため)。 */
  revokedSince(since: string): string[];
}

export type AuditKind = "connect" | "auth" | "geo" | "operation" | "http" | "token";

export interface AuditEntry {
  readonly kind: AuditKind;
  readonly tokenId: string | null;
  readonly discordUserId: string | null;
  readonly country: string | null;
  /** 末尾をマスク済みの送信元。 生の IP は渡さない。 */
  readonly ip: string | null;
  readonly operation: string;
  readonly result: string;
  readonly detail?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
}

/** 海外接続の通知先 (neco への Discord 通知)。 */
export interface OverseasNotifier {
  notify(input: { tokenLabel: string | null; discordUserId: string; country: string | null; maskedIp: string | null; policy: string; blocked: boolean }): Promise<void>;
}

export interface HubMember {
  readonly discordUserId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface ChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: "text" | "thread" | "announcement" | "forum_post";
}

export interface MessageSummary {
  readonly id: string;
  readonly authorName: string;
  readonly content: string;
  readonly createdAt: string;
  readonly attachments: readonly { readonly name: string; readonly url: string }[];
  readonly replyTo?: string;
}

export interface ChannelAccess {
  readonly view: boolean;
  readonly readHistory: boolean;
  readonly send: boolean;
  readonly react: boolean;
}

/** Discord の GLab guild に対する読み書き。 権限判定に使う値も返す。 */
export interface DiscordGateway {
  /** GLab のメンバーなら表示名など、 抜けていれば null。 */
  member(discordUserId: string): Promise<HubMember | null>;
  listChannels(): Promise<ChannelSummary[]>;
  access(discordUserId: string, channelId: string): Promise<ChannelAccess | null>;
  listMessages(channelId: string, input: { before?: string; limit: number }): Promise<MessageSummary[]>;
  postAs(member: HubMember, channelId: string, input: { content: string; replyTo?: string }): Promise<{ messageId: string }>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** バグ報告チャンネルへログを添付で上げ、 添付の URL を返す。 */
  uploadLogs(input: { title: string; reporter: HubMember; files: readonly { name: string; content: Buffer }[] }): Promise<Array<{ name: string; url: string }>>;
  onMessage(listener: (channelId: string, message: MessageSummary) => void): () => void;
  onMemberLeave(listener: (discordUserId: string) => void): () => void;
}

export interface BreviariumPort {
  listProjects(): Promise<unknown>;
  projectOverview(project: string): Promise<unknown>;
}

export interface NotionBoardPort {
  query(boardId: string, cursor: string | undefined): Promise<{ items: BoardItem[]; nextCursor: string | null }>;
  update(boardId: string, pageId: string, input: { title?: string; status?: string; due?: string | null }): Promise<{ pageId: string }>;
  create(boardId: string, input: { title: string; status?: string }): Promise<{ pageId: string }>;
}

export interface ActioSprintPort {
  aggregate(project: string): Promise<ActioSprintAggregate>;
  sprintTasks(project: string, sprintId: string): Promise<SprintTaskRow[]>;
  /** 設定済みプロジェクトのどこかにあるタスク。 無ければ null。 */
  findTask(taskId: string): Promise<{ project: string; assigneeId: string | null } | null>;
  setStatus(project: string, taskId: string, status: string): Promise<void>;
}

export interface IssuePort {
  createIssue(input: { repo: string; title: string; body: string; labels: string[] }): Promise<string>;
  commentOnPullRequest(repo: string, number: number, body: string): Promise<void>;
  pullRequestDiff(repo: string, number: number): Promise<string>;
}

export interface PraeformaSpecPort {
  createFragment(praeformaProjectId: string, input: { content: string; sourceEventId: string }): Promise<{ fragmentId: string }>;
  /** 再構築案を作る。 作れなければ理由付きで null。 */
  requestReconstruction(praeformaProjectId: string): Promise<{ reconstructionId: string; changeCount: number } | { reconstructionId: null; reason: string }>;
  fragmentDispositions(praeformaProjectId: string): Promise<Map<string, string>>;
  pendingReconstruction(praeformaProjectId: string): Promise<{ id: string; changeCount: number } | null>;
  decide(praeformaProjectId: string, reconstructionId: string, decision: { rejectedChanges: Array<{ index: number; reason: string }> }): Promise<void>;
  /** 断片の Praeforma 上の場所 (公開 URL が設定されていなければ null)。 */
  linkFor(praeformaProjectId: string): string | null;
}

export interface SpecDraftRecord {
  readonly id: string;
  readonly project: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headSha: string;
  readonly title: string;
  readonly praeformaProjectId: string;
  readonly fragmentId: string | null;
  readonly reconstructionId: string | null;
  readonly status: SpecDraftStatus;
  readonly body: string;
  readonly reviewedBy: string | null;
  readonly reviewComment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpecJob extends PullRequestEvent {
  readonly jobId: number;
}

export interface SpecDraftStore {
  enqueueJob(event: PullRequestEvent, at: string): boolean;
  claimJob(at: string): SpecJob | null;
  finishJob(jobId: number, at: string, error: string | null): void;
  saveDraft(draft: SpecDraftRecord): void;
  listDrafts(project: string): SpecDraftRecord[];
  getDraft(id: string): SpecDraftRecord | null;
  updateDraft(id: string, patch: Partial<Pick<SpecDraftRecord, "status" | "reviewedBy" | "reviewComment" | "updatedAt" | "reconstructionId">>): void;
}

export interface CalliopeStore {
  load(project: string): CalliopeProduct | null;
  save(product: CalliopeProduct): void;
}

export interface CalliopeMaterialsPort {
  collect(project: string): Promise<CalliopeMaterial[]>;
}

export interface CalliopeWriterPort {
  /** 指示文から文章を作る。 失敗は null。 */
  write(prompt: string): Promise<string | null>;
}
