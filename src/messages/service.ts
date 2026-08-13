/**
 * eventBus 購読 → projector (`project.ts`) → repo 永続化 → `session.message` /
 * `session.message.summary` emit (spec/feature/session-message-layer.md §4)。
 */

import { eventBus, eventSessionId, type ConcordiaEvent, type SessionMessagePayload } from "../events.js";
import type { SessionMessagesRepo, SessionMessageRow } from "../db/session-messages-repo.js";
import { projectEvent, ToolUseDedupeContext, type ProjectContext, type ProjectedMessage } from "./project.js";

/** ProjectContext 起動時復元 (Task dedupe_key) で遡る最大件数。 project.ts の LRU 上限と揃える。 */
const TASK_CONTEXT_RESTORE_LIMIT = 200;

export interface SessionMessageServiceDeps {
  repo: SessionMessagesRepo;
  /**
   * assistant の thinking frame を session_messages に落とすか (既定 OFF —
   * 2026-08-12 neco 指示: 中継面に thinking が出るのは不要なことが多い)。
   * 未注入時も OFF。値は都度解決 (WebUI から再起動なしで切替可)。
   */
  isThinkingEnabled?: () => boolean;
  /** テスト差し替え用。 既定は eventBus.subscribe。 */
  subscribe?: (listener: (ev: ConcordiaEvent) => void) => () => void;
  /** テスト差し替え用。 既定は eventBus.emit。 */
  emit?: (ev: ConcordiaEvent) => void;
}

export class SessionMessageService {
  private readonly contexts = new Map<string, ProjectContext>();

  constructor(private readonly deps: SessionMessageServiceDeps) {}

  start(): () => void {
    const subscribe = this.deps.subscribe ?? ((listener: (ev: ConcordiaEvent) => void) => eventBus.subscribe(listener));
    return subscribe((ev) => this.project(ev));
  }

  project(ev: ConcordiaEvent): void {
    const sessionId = eventSessionId(ev);
    if (!sessionId) return;
    // thinking は既定で記録しない (記録しなければ WebUI / Discord / Slack の全面から消える)。
    if (ev.type === "transcript.frame" && ev.kind === "thinking" && !this.deps.isThinkingEnabled?.()) {
      return;
    }
    const ctx = this.contextFor(sessionId);
    for (const msg of projectEvent(ev, ctx)) {
      this.persistAndEmit(sessionId, ev.ts, msg);
    }
  }

  private contextFor(sessionId: string): ProjectContext {
    let ctx = this.contexts.get(sessionId);
    if (!ctx) {
      ctx = new ToolUseDedupeContext();
      this.hydrateContext(sessionId, ctx);
      this.contexts.set(sessionId, ctx);
    }
    return ctx;
  }

  /**
   * 再起動でメモリ上の LRU が失われても、 直後の tool-result frame が Task の
   * create/update 紐付けを続けられるよう、 直近の `task:` dedupe_key を repo から復元する。
   * repo は新しい順で返すため、 逆順に詰め直して LRU の新しさ順序を保つ。
   */
  private hydrateContext(sessionId: string, ctx: ProjectContext): void {
    const recent = this.deps.repo.listRecentTaskDedupeKeys(sessionId, TASK_CONTEXT_RESTORE_LIMIT);
    for (const entry of recent.slice().reverse()) {
      const toolUseId = typeof entry.metadata?.tool_use_id === "string" ? entry.metadata.tool_use_id : null;
      if (toolUseId) ctx.rememberToolUseDedupeKey(toolUseId, entry.dedupe_key);
    }
  }

  private persistAndEmit(sessionId: string, ts: number, msg: ProjectedMessage): void {
    const existingId = msg.op === "update" && msg.dedupe_key !== null
      ? this.deps.repo.findIdByDedupeKey(sessionId, msg.dedupe_key)
      : null;
    const existing = existingId == null ? null : this.deps.repo.getById(existingId);
    const referenceId = msg.reference_dedupe_key
      ? this.deps.repo.findIdByDedupeKey(sessionId, msg.reference_dedupe_key)
      : (existing?.reference_id ?? null);
    const metadata = msg.metadata === undefined
      ? (existing?.metadata ?? null)
      : { ...(existing?.metadata ?? {}), ...msg.metadata };
    const { row, op } = this.deps.repo.upsert({
      session_id: sessionId,
      ts,
      author_type: msg.author_type ?? existing?.author_type ?? "system",
      author_label: msg.author_label ?? existing?.author_label ?? "System",
      author_platform: msg.author_platform === undefined
        ? (existing?.author_platform ?? null)
        : msg.author_platform,
      content: msg.content ?? existing?.content ?? "",
      embeds: msg.embeds === undefined ? (existing?.embeds ?? null) : msg.embeds,
      components: msg.components === undefined ? (existing?.components ?? null) : msg.components,
      attachments: msg.attachments === undefined ? (existing?.attachments ?? null) : msg.attachments,
      reference_id: referenceId,
      metadata,
      dedupe_key: msg.dedupe_key,
    });

    const emit = this.deps.emit ?? ((e: ConcordiaEvent) => eventBus.emit(e));
    const emittedTs = row.edited_ts ?? row.ts;
    emit({
      type: "session.message",
      target_session_id: sessionId,
      op,
      message: toPayload(row),
      ts: emittedTs,
    });
    emit({
      type: "session.message.summary",
      target_session_id: sessionId,
      latest_id: row.id,
      ts: emittedTs,
    });
  }
}

function toPayload(row: SessionMessageRow): SessionMessagePayload {
  return {
    id: row.id,
    session_id: row.session_id,
    ts: row.ts,
    edited_ts: row.edited_ts,
    author_type: row.author_type,
    author_label: row.author_label,
    author_platform: row.author_platform,
    content: row.content,
    embeds: row.embeds,
    components: row.components,
    attachments: row.attachments,
    reference_id: row.reference_id,
    metadata: row.metadata,
    dedupe_key: row.dedupe_key,
  };
}
