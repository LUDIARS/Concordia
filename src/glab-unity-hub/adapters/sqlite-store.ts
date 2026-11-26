/**
 * GLab-UnityHub が所有する SQLite (トークン・監査・カリオペ・仕様下書き)。
 *
 * Concordia 本体の DB (schema 台帳と指紋で管理) とは別ファイルにする。 拡張モジュールの
 * データはモジュールが持ち、 モジュールを外しても本体のスキーマが変わらないようにする。
 * Discord コマンド (Bot のプロセス) と Hub worker (別プロセス) が同じファイルを WAL で共有する。
 *
 * 平文トークンは保存しない (SHA-256 だけ)。 監査の IP は末尾マスク済みの値だけ受ける。
 *
 * @implements spec/feature/glab-unity-hub.md §1 / §2 (GUH-STORE)
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredToken } from "../domain/token-policy.js";
import type { CalliopeProduct } from "../domain/calliope-product.js";
import type { PullRequestEvent, SpecDraftStatus } from "../domain/spec-draft.js";
import type {
  AuditEntry,
  AuditLog,
  CalliopeStore,
  SpecDraftRecord,
  SpecDraftStore,
  SpecJob,
  TokenStore,
} from "../application/ports.js";

export const GLAB_UNITY_HUB_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS glab_unity_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS glab_unity_tokens_user ON glab_unity_tokens(discord_user_id);
CREATE INDEX IF NOT EXISTS glab_unity_tokens_revoked ON glab_unity_tokens(revoked_at);
CREATE TABLE IF NOT EXISTS glab_unity_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  token_id TEXT,
  discord_user_id TEXT,
  country TEXT,
  ip TEXT,
  operation TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS glab_unity_audit_at ON glab_unity_audit(at);
CREATE TABLE IF NOT EXISTS glab_unity_calliope (
  project TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS glab_unity_spec_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  title TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT NOT NULL,
  claimed_at TEXT,
  done_at TEXT,
  error TEXT,
  UNIQUE(repo, pr_number, head_sha)
);
CREATE TABLE IF NOT EXISTS glab_unity_spec_drafts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  title TEXT NOT NULL,
  praeforma_project_id TEXT NOT NULL,
  fragment_id TEXT,
  reconstruction_id TEXT,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo, pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS glab_unity_spec_drafts_project ON glab_unity_spec_drafts(project, updated_at);
`;

/** 取り出したまま終わらなかったジョブを拾い直すまでの時間。 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function tokenOf(row: Row): StoredToken {
  return {
    id: text(row.id),
    tokenHash: text(row.token_hash),
    displayPrefix: text(row.display_prefix),
    discordUserId: text(row.discord_user_id),
    guildId: text(row.guild_id),
    label: nullable(row.label),
    createdAt: text(row.created_at),
    expiresAt: text(row.expires_at),
    lastUsedAt: nullable(row.last_used_at),
    revokedAt: nullable(row.revoked_at),
  };
}

function draftOf(row: Row): SpecDraftRecord {
  return {
    id: text(row.id),
    project: text(row.project),
    repo: text(row.repo),
    prNumber: Number(row.pr_number),
    prUrl: text(row.pr_url),
    headSha: text(row.head_sha),
    title: text(row.title),
    praeformaProjectId: text(row.praeforma_project_id),
    fragmentId: nullable(row.fragment_id),
    reconstructionId: nullable(row.reconstruction_id),
    status: text(row.status) as SpecDraftStatus,
    body: text(row.body),
    reviewedBy: nullable(row.reviewed_by),
    reviewComment: nullable(row.review_comment),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** ファイルを開いてスキーマを用意する。 `:memory:` はテスト用。 */
export function openGlabUnityHubDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  db.pragma(`user_version = ${GLAB_UNITY_HUB_SCHEMA_VERSION}`);
  return db;
}

export class SqliteGlabUnityStore implements TokenStore, AuditLog, CalliopeStore, SpecDraftStore {
  constructor(private readonly db: Database.Database, private readonly clock: () => Date = () => new Date()) {}

  insert(token: StoredToken): void {
    this.db.prepare(`INSERT INTO glab_unity_tokens
      (id, token_hash, display_prefix, discord_user_id, guild_id, label, created_at, expires_at, last_used_at, revoked_at)
      VALUES (@id, @tokenHash, @displayPrefix, @discordUserId, @guildId, @label, @createdAt, @expiresAt, @lastUsedAt, @revokedAt)`)
      .run(token);
  }

  findByHash(hash: string): StoredToken | null {
    const row = this.db.prepare("SELECT * FROM glab_unity_tokens WHERE token_hash = ?").get(hash) as Row | undefined;
    return row ? tokenOf(row) : null;
  }

  listByUser(discordUserId: string): StoredToken[] {
    return (this.db.prepare("SELECT * FROM glab_unity_tokens WHERE discord_user_id = ? ORDER BY created_at")
      .all(discordUserId) as Row[]).map(tokenOf);
  }

  revoke(id: string, at: string): boolean {
    return this.db.prepare("UPDATE glab_unity_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes > 0;
  }

  touch(id: string, at: string): void {
    this.db.prepare("UPDATE glab_unity_tokens SET last_used_at = ? WHERE id = ?").run(at, id);
  }

  revokedSince(since: string): string[] {
    return (this.db.prepare("SELECT id FROM glab_unity_tokens WHERE revoked_at IS NOT NULL AND revoked_at > ?")
      .all(since) as Row[]).map((row) => text(row.id));
  }

  /** `since` 以降に期限が来たトークン (接続中のものを切る)。 */
  expiredBetween(since: string, until: string): string[] {
    return (this.db.prepare("SELECT id FROM glab_unity_tokens WHERE expires_at > ? AND expires_at <= ?")
      .all(since, until) as Row[]).map((row) => text(row.id));
  }

  record(entry: AuditEntry): void {
    this.db.prepare(`INSERT INTO glab_unity_audit (at, kind, token_id, discord_user_id, country, ip, operation, result, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.clock().toISOString(), entry.kind, entry.tokenId, entry.discordUserId, entry.country, entry.ip,
      entry.operation.slice(0, 120), entry.result.slice(0, 120), entry.detail?.slice(0, 500) ?? null,
    );
  }

  load(project: string): CalliopeProduct | null {
    const row = this.db.prepare("SELECT payload FROM glab_unity_calliope WHERE project = ?").get(project) as Row | undefined;
    if (!row) return null;
    try {
      return JSON.parse(text(row.payload)) as CalliopeProduct;
    } catch {
      return null;
    }
  }

  save(product: CalliopeProduct): void {
    this.db.prepare(`INSERT INTO glab_unity_calliope (project, payload, generated_at) VALUES (?, ?, ?)
      ON CONFLICT(project) DO UPDATE SET payload = excluded.payload, generated_at = excluded.generated_at`)
      .run(product.project, JSON.stringify(product), product.generatedAt);
  }

  enqueueJob(event: PullRequestEvent, at: string): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO glab_unity_spec_jobs (repo, pr_number, head_sha, pr_url, title, draft, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.repo, event.number, event.headSha, event.url, event.title, event.draft ? 1 : 0, at).changes > 0;
  }

  claimJob(at: string): SpecJob | null {
    const staleBefore = new Date(Date.parse(at) - STALE_CLAIM_MS).toISOString();
    const claim = this.db.transaction((): Row | undefined => {
      const row = this.db.prepare(`SELECT * FROM glab_unity_spec_jobs
        WHERE done_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY id LIMIT 1`).get(staleBefore) as Row | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE glab_unity_spec_jobs SET claimed_at = ? WHERE id = ?").run(at, row.id);
      return row;
    });
    const row = claim();
    if (!row) return null;
    return {
      jobId: Number(row.id), repo: text(row.repo), number: Number(row.pr_number), headSha: text(row.head_sha),
      url: text(row.pr_url), title: text(row.title), draft: Number(row.draft) === 1,
    };
  }

  finishJob(jobId: number, at: string, error: string | null): void {
    this.db.prepare("UPDATE glab_unity_spec_jobs SET done_at = ?, error = ? WHERE id = ?").run(at, error, jobId);
  }

  saveDraft(draft: SpecDraftRecord): void {
    this.db.prepare(`INSERT OR IGNORE INTO glab_unity_spec_drafts
      (id, project, repo, pr_number, pr_url, head_sha, title, praeforma_project_id, fragment_id, reconstruction_id,
       status, body, reviewed_by, review_comment, created_at, updated_at)
      VALUES (@id, @project, @repo, @prNumber, @prUrl, @headSha, @title, @praeformaProjectId, @fragmentId, @reconstructionId,
       @status, @body, @reviewedBy, @reviewComment, @createdAt, @updatedAt)`).run(draft);
  }

  listDrafts(project: string): SpecDraftRecord[] {
    return (this.db.prepare("SELECT * FROM glab_unity_spec_drafts WHERE project = ? ORDER BY updated_at DESC LIMIT 200")
      .all(project) as Row[]).map(draftOf);
  }

  getDraft(id: string): SpecDraftRecord | null {
    const row = this.db.prepare("SELECT * FROM glab_unity_spec_drafts WHERE id = ?").get(id) as Row | undefined;
    return row ? draftOf(row) : null;
  }

  updateDraft(id: string, patch: Partial<Pick<SpecDraftRecord, "status" | "reviewedBy" | "reviewComment" | "updatedAt" | "reconstructionId">>): void {
    const columns: Record<string, string> = {
      status: "status", reviewedBy: "reviewed_by", reviewComment: "review_comment", updatedAt: "updated_at", reconstructionId: "reconstruction_id",
    };
    const entries = Object.entries(patch).filter(([key, value]) => value !== undefined && columns[key]);
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
    this.db.prepare(`UPDATE glab_unity_spec_drafts SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  }
}
