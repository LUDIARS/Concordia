/**
 * transcript.frame / session.inject / question.* / permission / delegation.mirror /
 * operational.claim.* を `session_messages` の 1 行に落とす純関数 projector
 * (spec/feature/session-message-layer.md §4)。
 *
 * DB も `Date.now()` も触らない。 呼び出し側 (src/messages/service.ts) が
 * イベントの `ts` を渡し、 永続化と `session.message` emit を担う。
 */

import type { ConcordiaEvent } from "../events.js";
import type {
  Attachment,
  Component,
  Embed,
  SessionMessageAuthorType,
} from "../shared/session-message-types.js";

export type {
  Attachment,
  Component,
  Embed,
  EmbedField,
  SessionMessageAuthorType,
} from "../shared/session-message-types.js";

interface ProjectedMessageBase {
  dedupe_key: string | null;
  embeds?: Embed[];
  components?: Component[];
  attachments?: Attachment[];
  /** 解決 (dedupe_key → 実際の reference_id) はサービス層が repo lookup で行う。 */
  reference_dedupe_key?: string;
  metadata?: Record<string, unknown>;
}

export type ProjectedMessage = ProjectedMessageBase & (
  | {
      op: "create";
      author_type: SessionMessageAuthorType;
      author_label: string;
      author_platform: string | null;
      content: string;
    }
  | {
      /** Omitted fields retain the existing canonical-message value. */
      op: "update";
      author_type?: SessionMessageAuthorType;
      author_label?: string;
      author_platform?: string | null;
      content?: string;
    }
);

/**
 * `tool_use_id → dedupe_key` の直近解決状態 (spec §4 の Task create/update 紐付けと、
 * 通常 tool-result の「直前 tool-use への reference」解決に使う薄い LRU)。
 * セッションごとに 1 インスタンス。 上限を超えた分は最古から捨てる。
 */
export interface ProjectContext {
  getToolUseDedupeKey(toolUseId: string): string | undefined;
  rememberToolUseDedupeKey(toolUseId: string, dedupeKey: string): void;
}

const DEFAULT_CONTEXT_LIMIT = 200;

export class ToolUseDedupeContext implements ProjectContext {
  private readonly map = new Map<string, string>();

  constructor(private readonly limit: number = DEFAULT_CONTEXT_LIMIT) {}

  getToolUseDedupeKey(toolUseId: string): string | undefined {
    return this.map.get(toolUseId);
  }

  rememberToolUseDedupeKey(toolUseId: string, dedupeKey: string): void {
    // Map の挿入順 = 古い順。 既存キーは delete→set で末尾へ移し、 直近アクセス優先で回す。
    this.map.delete(toolUseId);
    this.map.set(toolUseId, dedupeKey);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export function projectEvent(ev: ConcordiaEvent, ctx: ProjectContext): ProjectedMessage[] {
  switch (ev.type) {
    case "transcript.frame":
      return projectTranscriptFrame(ev, ctx);
    case "session.inject":
      return [projectSessionInject(ev)];
    case "question.posted":
      return [projectQuestionPosted(ev)];
    case "question.answered":
      return [projectQuestionAnswered(ev)];
    case "question.resolved":
      return [projectQuestionResolved(ev)];
    case "session.permission_request":
      return [projectPermissionRequest(ev)];
    case "delegation.mirror":
      return [projectDelegationMirror(ev)];
    case "operational.claim.opened":
      return [projectClaimOpened(ev)];
    case "operational.claim.released":
      return [projectClaimReleased(ev)];
    default:
      return [];
  }
}

function projectTranscriptFrame(
  ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>,
  ctx: ProjectContext,
): ProjectedMessage[] {
  const frameDedupeKey = `frame:${ev.seq}`;
  const p = asRecord(ev.payload);

  switch (ev.kind) {
    case "text": {
      const role = typeof p.role === "string" ? p.role : null;
      const text = typeof p.text === "string" ? p.text : "";
      if (!text || (role !== "user" && role !== "assistant")) return [];
      return [{
        op: "create",
        dedupe_key: frameDedupeKey,
        author_type: role,
        author_label: role === "user" ? "User" : "Assistant",
        author_platform: null,
        content: text,
      }];
    }
    case "thinking": {
      const preview = typeof p.preview === "string" ? p.preview : "";
      if (!preview) return [];
      return [{
        op: "create",
        dedupe_key: frameDedupeKey,
        author_type: "thinking",
        author_label: "Assistant",
        author_platform: null,
        content: preview,
      }];
    }
    case "summary": {
      const text = typeof p.text === "string" ? p.text : "";
      if (!text) return [];
      return [{
        op: "create",
        dedupe_key: frameDedupeKey,
        author_type: "summary",
        author_label: "Summary",
        author_platform: null,
        content: text,
      }];
    }
    case "image": {
      const data = typeof p.data === "string" ? p.data : "";
      if (!data) return [];
      const mediaType = typeof p.media_type === "string" ? p.media_type : "image/png";
      return [{
        op: "create",
        dedupe_key: frameDedupeKey,
        author_type: "assistant",
        author_label: "Assistant",
        author_platform: null,
        content: "",
        attachments: [{ kind: "image", media_type: mediaType, data }],
      }];
    }
    case "tool-use":
      return projectToolUse(p, frameDedupeKey, ctx);
    case "tool-result":
      return projectToolResult(p, frameDedupeKey, ctx);
    default:
      return [];
  }
}

function projectToolUse(
  p: Record<string, unknown>,
  frameDedupeKey: string,
  ctx: ProjectContext,
): ProjectedMessage[] {
  const toolUseId = typeof p.tool_use_id === "string" ? p.tool_use_id : "";
  const name = typeof p.name === "string" ? p.name : "tool";
  const task = asRecord(p.task);

  if (name === "Task" && toolUseId) {
    const dedupeKey = `task:${toolUseId}`;
    ctx.rememberToolUseDedupeKey(toolUseId, dedupeKey);
    const subagentType = typeof task.subagent_type === "string" ? task.subagent_type : "";
    const description = typeof task.description === "string" ? task.description : "";
    return [{
      op: "create",
      dedupe_key: dedupeKey,
      author_type: "task",
      author_label: subagentType || "Task",
      author_platform: null,
      content: description,
      embeds: [{
        title: "Task",
        fields: [
          { name: "subagent_type", value: subagentType || "-" },
          { name: "description", value: description || "-" },
          { name: "status", value: "running" },
        ],
      }],
      metadata: { tool_use_id: toolUseId },
    }];
  }

  if (toolUseId) ctx.rememberToolUseDedupeKey(toolUseId, frameDedupeKey);
  const inputPreview = typeof p.input_preview === "string" ? p.input_preview : "";
  return [{
    op: "create",
    dedupe_key: frameDedupeKey,
    author_type: "tool",
    author_label: name,
    author_platform: null,
    content: inputPreview,
    metadata: toolUseId ? { tool_use_id: toolUseId } : undefined,
  }];
}

function projectToolResult(
  p: Record<string, unknown>,
  frameDedupeKey: string,
  ctx: ProjectContext,
): ProjectedMessage[] {
  const toolUseId = typeof p.tool_use_id === "string" ? p.tool_use_id : "";
  const preview = typeof p.preview === "string" ? p.preview : "";
  const isError = p.is_error === true;
  const knownDedupeKey = toolUseId ? ctx.getToolUseDedupeKey(toolUseId) : undefined;

  if (knownDedupeKey?.startsWith("task:")) {
    return [{
      op: "update",
      dedupe_key: knownDedupeKey,
      author_type: "task",
      content: preview,
      embeds: [{
        title: "Task",
        fields: [
          { name: "status", value: isError ? "failed" : "completed" },
          { name: "result", value: preview || "-" },
        ],
      }],
      metadata: { tool_use_id: toolUseId, is_error: isError },
    }];
  }

  return [{
    op: "create",
    dedupe_key: frameDedupeKey,
    author_type: "tool",
    author_label: "Tool",
    author_platform: null,
    content: preview,
    ...(knownDedupeKey ? { reference_dedupe_key: knownDedupeKey } : {}),
    metadata: toolUseId ? { tool_use_id: toolUseId, is_error: isError } : { is_error: isError },
  }];
}

function projectSessionInject(
  ev: Extract<ConcordiaEvent, { type: "session.inject" }>,
): ProjectedMessage {
  return {
    op: "create",
    // session.inject has no stable event/message ID. A timestamp/text hash would collapse two
    // legitimate identical messages in the same second, so use the explicit always-insert path.
    dedupe_key: null,
    author_type: "user",
    author_label: ev.author_label ?? "User",
    author_platform: derivePlatformFromSource(ev.source),
    content: ev.text,
  };
}

function projectQuestionPosted(
  ev: Extract<ConcordiaEvent, { type: "question.posted" }>,
): ProjectedMessage {
  const options = ev.options.map((opt, index) =>
    typeof opt === "string"
      ? { index, label: opt }
      : { index, label: opt.label, description: opt.description },
  );
  return {
    op: "create",
    dedupe_key: `question:${ev.question_id}`,
    author_type: "question",
    author_label: "Question",
    author_platform: ev.requester_platform ?? null,
    content: ev.question,
    components: [{ kind: "question_options", options, multi_select: ev.multi_select ?? false }],
    metadata: {
      question_id: ev.question_id,
    },
  };
}

function projectQuestionAnswered(
  ev: Extract<ConcordiaEvent, { type: "question.answered" }>,
): ProjectedMessage {
  return {
    op: "update",
    dedupe_key: `question:${ev.question_id}`,
    author_type: "question",
    metadata: {
      question_id: ev.question_id,
      answer_index: ev.answer_index,
      answer_text: ev.answer_text,
      answered: true,
    },
  };
}

function projectQuestionResolved(
  ev: Extract<ConcordiaEvent, { type: "question.resolved" }>,
): ProjectedMessage {
  return {
    op: "update",
    dedupe_key: `question:${ev.question_id}`,
    author_type: "question",
    metadata: { question_id: ev.question_id, resolved: true },
  };
}

function projectPermissionRequest(
  ev: Extract<ConcordiaEvent, { type: "session.permission_request" }>,
): ProjectedMessage {
  return {
    op: "create",
    dedupe_key: `permission:${ev.request_id}`,
    author_type: "permission",
    author_label: "Permission",
    author_platform: ev.requester_platform ?? null,
    content: `${ev.tool_name} の実行許可を求めています`,
    components: [{ kind: "permission_actions", tool_name: ev.tool_name, request_id: ev.request_id }],
    metadata: {
      request_id: ev.request_id,
      tool_name: ev.tool_name,
    },
  };
}

function projectDelegationMirror(
  ev: Extract<ConcordiaEvent, { type: "delegation.mirror" }>,
): ProjectedMessage {
  const linkSide = ev.link_side;
  return {
    op: "create",
    dedupe_key: linkSide
      ? `delegation:${ev.run_id}:${linkSide}`
      : `delegation:${ev.run_id}`,
    author_type: "delegation",
    author_label: "Delegation",
    author_platform: null,
    content: ev.text,
    metadata: {
      run_id: ev.run_id,
      ...(ev.parent_session_id ? { parent_session_id: ev.parent_session_id } : {}),
      ...(ev.child_session_id ? { child_session_id: ev.child_session_id } : {}),
    },
  };
}

function projectClaimOpened(
  ev: Extract<ConcordiaEvent, { type: "operational.claim.opened" }>,
): ProjectedMessage {
  return {
    op: "create",
    dedupe_key: `claim:${ev.claim_id}:opened`,
    author_type: "system",
    author_label: "System",
    author_platform: null,
    content: `claim opened: ${ev.claim_kind} ${ev.resource}${ev.note ? ` — ${ev.note}` : ""}`,
    metadata: {
      claim_id: ev.claim_id,
      claim_kind: ev.claim_kind,
      resource: ev.resource,
      branch: ev.branch,
      conflict_session_ids: ev.conflict_session_ids,
    },
  };
}

function projectClaimReleased(
  ev: Extract<ConcordiaEvent, { type: "operational.claim.released" }>,
): ProjectedMessage {
  return {
    op: "create",
    dedupe_key: `claim:${ev.claim_id}:released`,
    author_type: "system",
    author_label: "System",
    author_platform: null,
    content: `claim released: ${ev.claim_kind} ${ev.resource}${ev.note ? ` — ${ev.note}` : ""}`,
    metadata: { claim_id: ev.claim_id, claim_kind: ev.claim_kind, resource: ev.resource },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function derivePlatformFromSource(source: string | null): string | null {
  if (!source) return null;
  if (source.startsWith("discord")) return "discord";
  if (source.startsWith("slack")) return "slack";
  if (source.startsWith("web")) return "web";
  if (source.startsWith("lictor")) return "lictor";
  return null;
}

