/**
 * 巡回チャットの知識の取り込み (spec/feature/patrol-chat.md「知識」)。
 *
 *   取り込み器 → 秘匿語で文書を除く → 断片に切る → 種類ごと (全件) / 文書ごと (差分) に置き換え → 状態を記録
 *
 * - 定期: 種類ごとに最終成功から 1 日 (Notion 記事マップは 1 週) で取り直す。 失敗した種類は 1 時間あけて再試行する
 * - 手動: 指定した種類 (省略時は全部) を全件で取り直す
 * - 失敗は前回の断片を残し、 失敗理由だけを記録する。 種類どうしは独立 (Notion が止まっても他は動く)
 * - 失敗理由に秘密値 (Notion のトークン) が混ざっても伏せてから残す
 */

import type { ChatKnowledgeRepo, KnowledgeChunkInput } from "../db/chat-knowledge-repo.js";
import { chunkText, excludeConfidential } from "./knowledge-scope.js";
import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_SOURCE_KINDS,
  type KnowledgeCollector,
  type KnowledgeDoc,
  type KnowledgeSourceKind,
} from "./knowledge-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:b4cff1b8 */
import augurContract_b3fb8c13 from './knowledge-ingest.contract.js'; /* augur-inject:contract-predicate:b003ab7d */

export const KNOWLEDGE_REFRESH_SEC = 86_400;
export const KNOWLEDGE_RETRY_SEC = 3_600;
/** 種類ごとの取り直しの間隔。 Notion 記事マップは週 1 回 (neco 決定 2026-10-18)。 */
export const KNOWLEDGE_REFRESH_SEC_BY_KIND: Record<KnowledgeSourceKind, number> = {
  ludiars: KNOWLEDGE_REFRESH_SEC,
  revisor: KNOWLEDGE_REFRESH_SEC,
  notion: 7 * KNOWLEDGE_REFRESH_SEC,
};

export type RefreshOutcome =
  | { kind: KnowledgeSourceKind; status: "refreshed"; docs: number; chunks: number; excluded: number; full: boolean }
  | { kind: KnowledgeSourceKind; status: "not-configured"; reason: string }
  | { kind: KnowledgeSourceKind; status: "failed"; reason: string };

export interface KnowledgeSourceStatus {
  kind: KnowledgeSourceKind;
  configured: boolean;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  running: boolean;
  counts: Array<{ doc_type: string; scope: string; docs: number; chunks: number }>;
}

export interface KnowledgeIngestDeps {
  repo: ChatKnowledgeRepo;
  collectors: Partial<Record<KnowledgeSourceKind, KnowledgeCollector>>;
  /** 秘匿語の辞書 (読めなければ空)。 */
  confidentialTerms: () => Promise<string[]>;
  /** 失敗理由から伏せる秘密値 (Notion のトークン等)。 */
  secrets?: () => Array<string | null>;
  nowMs: () => number;
  log?: { warn: (msg: string) => void };
}

/** 失敗理由を短くし、 秘密値を伏せる。 */
export function redactReason(message: string, secrets: ReadonlyArray<string | null>): string {
  let out = message;
  for (const secret of secrets) {
    const s = secret?.trim();
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}
// @ts-expect-error augur-inject
redactReason = contract(redactReason, { ...augurContract_b3fb8c13, contractId: 'chat-knowledge-C-6', mode: 'observe', sample: 1, where: 'src/rules/knowledge-ingest.ts:52', rule: 'contract-wrap', id: 'b3fb8c13' }); /* augur-inject:contract-wrap:b3fb8c13 */

/** 文書を断片の行にする。 本文が空の文書は題だけの断片にする (プロジェクト一覧の行など)。 */
export function docsToChunks(docs: readonly KnowledgeDoc[]): KnowledgeChunkInput[] {
  const out: KnowledgeChunkInput[] = [];
  for (const doc of docs) {
    const parts = chunkText(doc.text, KNOWLEDGE_LIMITS.chunkBytes, KNOWLEDGE_LIMITS.maxChunksPerDoc);
    (parts.length ? parts : [doc.title]).forEach((body, seq) => out.push({
      doc_type: doc.docType,
      doc_key: doc.docKey,
      seq,
      title: doc.title,
      url: doc.url,
      repo: doc.repo,
      path: doc.path,
      scope: doc.scope,
      body,
      source_updated_at: doc.sourceUpdatedAt,
    }));
  }
  return out;
}

export interface KnowledgeIngest {
  /** 1 種類を取り込む。 失敗しても前回の断片を残す。 */
  refreshSource(kind: KnowledgeSourceKind, opts: { full: boolean }): Promise<RefreshOutcome>;
  /** 手動の取り直し (全件)。 */
  refresh(kinds?: KnowledgeSourceKind[]): Promise<RefreshOutcome[]>;
  /** 定期の取り込み (期日の来た種類だけ、 差分)。 */
  tick(): Promise<RefreshOutcome[]>;
  status(): KnowledgeSourceStatus[];
}

export function createKnowledgeIngest(deps: KnowledgeIngestDeps): KnowledgeIngest {
  const running = new Set<KnowledgeSourceKind>();
  const nowSec = () => Math.floor(deps.nowMs() / 1000);
  const secrets = () => deps.secrets?.() ?? [];

  const refreshSource = async (kind: KnowledgeSourceKind, opts: { full: boolean }): Promise<RefreshOutcome> => {
    const collector = deps.collectors[kind];
    if (!collector) return { kind, status: "not-configured", reason: "collector is not wired" };
    if (running.has(kind)) return { kind, status: "failed", reason: "already running" };
    running.add(kind);
    const startedAt = nowSec();
    deps.repo.markAttempt(kind, startedAt);
    try {
      const prior = deps.repo.source(kind);
      const collected = await collector({ cursor: opts.full ? null : prior?.cursor ?? null, full: opts.full });
      if ("notConfigured" in collected) {
        // 未設定は失敗ではない。 前回の断片は残し、 理由だけを見せる
        deps.repo.markFailure(kind, `not configured: ${collected.notConfigured}`, startedAt);
        return { kind, status: "not-configured", reason: collected.notConfigured };
      }
      const { docs, excluded } = excludeConfidential(collected.docs, await deps.confidentialTerms());
      const chunks = docsToChunks(docs);
      const at = nowSec();
      if (collected.full) {
        deps.repo.replaceAll(kind, chunks, at);
      } else {
        // 差分: 届いた文書は秘匿語で除いたものも含めて古い断片を消す (除いた文書の古い版を残さない)
        deps.repo.replaceDocs(kind, collected.docs.map((d) => d.docKey), chunks, at);
      }
      if (collected.retainDocKeys) deps.repo.retainDocs(kind, collected.retainDocKeys);
      deps.repo.markSuccess(kind, collected.cursor, at);
      return { kind, status: "refreshed", docs: docs.length, chunks: chunks.length, excluded, full: collected.full };
    } catch (err) {
      const reason = redactReason((err as Error).message || String(err), secrets());
      deps.repo.markFailure(kind, reason, nowSec());
      deps.log?.warn(`chat knowledge: ${kind} refresh failed: ${reason}`);
      return { kind, status: "failed", reason };
    } finally {
      running.delete(kind);
    }
  };

  const due = (kind: KnowledgeSourceKind, now: number): boolean => {
    const row = deps.repo.source(kind);
    if (!row?.last_success_at) return !row?.last_attempt_at || now - row.last_attempt_at >= KNOWLEDGE_RETRY_SEC;
    if (now - row.last_success_at >= KNOWLEDGE_REFRESH_SEC_BY_KIND[kind]) {
      return !row.last_attempt_at || row.last_attempt_at <= row.last_success_at || now - row.last_attempt_at >= KNOWLEDGE_RETRY_SEC;
    }
    return false;
  };

  const wired = () => KNOWLEDGE_SOURCE_KINDS.filter((k) => deps.collectors[k]);

  return {
    refreshSource,
    refresh: async (kinds) => {
      const out: RefreshOutcome[] = [];
      for (const kind of kinds ?? wired()) out.push(await refreshSource(kind, { full: true }));
      return out;
    },
    tick: async () => {
      const now = nowSec();
      const out: RefreshOutcome[] = [];
      for (const kind of wired()) {
        if (due(kind, now)) out.push(await refreshSource(kind, { full: false }));
      }
      return out;
    },
    status: () => {
      const counts = deps.repo.counts();
      return KNOWLEDGE_SOURCE_KINDS.map((kind) => {
        const row = deps.repo.source(kind);
        return {
          kind,
          configured: Boolean(deps.collectors[kind]) && !(row?.last_error ?? "").startsWith("not configured"),
          last_attempt_at: row?.last_attempt_at ?? null,
          last_success_at: row?.last_success_at ?? null,
          last_error: row?.last_error ? redactReason(row.last_error, secrets()) : null,
          running: running.has(kind),
          counts: counts.filter((c) => c.source_kind === kind)
            .map((c) => ({ doc_type: c.doc_type, scope: c.scope, docs: c.docs, chunks: c.chunks })),
        };
      });
    },
  };
}
