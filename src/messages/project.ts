/**
 * transcript.frame / session.inject / question.* / permission / delegation.mirror /
 * operational.claim.* を `session_messages` の 1 行に落とす純関数 projector
 * (spec/feature/session-message-layer.md §4)。
 *
 * DB も `Date.now()` も触らない。 呼び出し側 (src/messages/service.ts) が
 * イベントの `ts` を渡し、 永続化と `session.message` emit を担う。
 */

import type { ConcordiaEvent } from "../events.js";
import { buildToolFailureDetail } from "./tool-failure.js";
import type {
  Attachment,
  Component,
  Embed,
  SessionMessageAuthorType,
} from "../shared/session-message-types.js";
import { injectionAuthorLabel, injectionProvenanceMetadata } from "./injection-provenance.js";

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

/** 直前の tool-use 1 件。 tool-result が元の message を更新するときに引く。 */
export interface ToolUseMemo {
  /** 更新先の message を引くキー。 */
  dedupeKey: string;
  /** ツール名 (Bash / Edit / …)。 失敗時の内訳に使う。 */
  tool: string;
  /** 入力の先頭プレビュー (Lictor 側で 200 字)。 失敗時の内訳に使う。 */
  inputPreview: string;
}

/**
 * `tool_use_id → 直前の tool-use` の解決状態 (spec §4 の Task create/update 紐付けと、
 * 通常 tool-result の「直前 tool-use への reference」解決に使う薄い LRU)。
 * セッションごとに 1 インスタンス。 上限を超えた分は最古から捨てる。
 *
 * コマンド本文をここだけに持ち、 永続化するのは失敗したときだけにする
 * (成功した全ツール引数を DB へ残さない)。 その代わり Cc 再起動をまたいだ
 * tool-result はコマンドを復元できず、 内訳はエラー出力だけになる。
 */
export interface ProjectContext {
  getToolUse(toolUseId: string): ToolUseMemo | undefined;
  rememberToolUse(toolUseId: string, memo: ToolUseMemo): void;
}

const DEFAULT_CONTEXT_LIMIT = 200;
const TOOL_MEMO_FIELD_LIMIT = 400;
const TOOL_RUNNING = "実行中";
const TOOL_SUCCEEDED = "成功";
const TOOL_FAILED = "失敗";

export class ToolUseDedupeContext implements ProjectContext {
  private readonly map = new Map<string, ToolUseMemo>();

  constructor(private readonly limit: number = DEFAULT_CONTEXT_LIMIT) {}

  getToolUse(toolUseId: string): ToolUseMemo | undefined {
    return this.map.get(toolUseId);
  }

  rememberToolUse(toolUseId: string, memo: ToolUseMemo): void {
    // Map の挿入順 = 古い順。 既存キーは delete→set で末尾へ移し、 直近アクセス優先で回す。
    this.map.delete(toolUseId);
    this.map.set(toolUseId, {
      ...memo,
      tool: memo.tool.slice(0, TOOL_MEMO_FIELD_LIMIT),
      inputPreview: memo.inputPreview.slice(0, TOOL_MEMO_FIELD_LIMIT),
    });
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
      const text = typeof p.text === "string" ? p.text : typeof p.preview === "string" ? p.preview : "";
      if (!text) return [];
      return [{
        op: "create",
        dedupe_key: frameDedupeKey,
        author_type: "thinking",
        author_label: "Assistant",
        author_platform: null,
        content: text,
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

  const inputPreview = typeof p.input_preview === "string" ? p.input_preview : "";

  if (name === "Task" && toolUseId) {
    const dedupeKey = `task:${toolUseId}`;
    ctx.rememberToolUse(toolUseId, { dedupeKey, tool: name, inputPreview });
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

  if (toolUseId) ctx.rememberToolUse(toolUseId, { dedupeKey: frameDedupeKey, tool: name, inputPreview });
  return [{
    op: "create",
    dedupe_key: frameDedupeKey,
    author_type: "tool",
    author_label: toolDisplayLabel(name, inputPreview),
    author_platform: null,
    // Tool arguments stay in the provider transcript / diagnostic relay. The
    // user-facing session_messages stream records only the tool lifecycle.
    content: TOOL_RUNNING,
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
  const memo = toolUseId ? ctx.getToolUse(toolUseId) : undefined;
  const knownDedupeKey = memo?.dedupeKey;
  // 失敗したときだけ「何が失敗したか」を metadata へ添える。 null は replay 時に
  // 以前の failure が shallow merge で残らないよう明示的に消すための値。
  // 本文 (content) は `失敗` のまま — Discord は tool の失敗だけを本文で中継するので、
  // 本文へ入れると生コマンドがチャンネルへ流れる (neco 指示は Cc の WebUI)。
  const failure = isError
    ? buildToolFailureDetail({
      tool: memo?.tool ?? "",
      inputPreview: memo?.inputPreview ?? "",
      resultPreview: preview,
    })
    : null;

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
      metadata: { tool_use_id: toolUseId, is_error: isError, failure },
    }];
  }

  if (knownDedupeKey) {
    return [{
      op: "update",
      dedupe_key: knownDedupeKey,
      author_type: "tool",
      content: isError ? TOOL_FAILED : TOOL_SUCCEEDED,
      metadata: { tool_use_id: toolUseId, is_error: isError, failure },
    }];
  }

  return [{
    op: "create",
    dedupe_key: frameDedupeKey,
    author_type: "tool",
    author_label: "Tool",
    author_platform: null,
    content: isError ? TOOL_FAILED : TOOL_SUCCEEDED,
    metadata: {
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      is_error: isError,
      failure,
    },
  }];
}

/** Extract only a skill name from its input; other tool arguments never reach the user-facing stream. */
function toolDisplayLabel(name: string, inputPreview: string): string {
  if (name !== "Skill") return name;
  try {
    const parsed = JSON.parse(inputPreview) as { skill?: unknown };
    const skill = typeof parsed.skill === "string" ? parsed.skill.trim() : "";
    return skill ? `Skill: ${skill}` : name;
  } catch {
    return name;
  }
}

function projectSessionInject(
  ev: Extract<ConcordiaEvent, { type: "session.inject" }>,
): ProjectedMessage {
  const metadata = injectionProvenanceMetadata(ev.provenance);
  return {
    op: "create",
    // session.inject has no stable event/message ID. A timestamp/text hash would collapse two
    // legitimate identical messages in the same second, so use the explicit always-insert path.
    dedupe_key: null,
    // 出所のある注入は user と分ける。 モデルへ渡す入力で「本人が書いた文」と
    // 「絵文字 1 つから機械的に展開されたテンプレート」を同じ重みで読ませない。
    author_type: ev.provenance ? "system" : "user",
    author_label: ev.author_label ?? (ev.provenance ? injectionAuthorLabel(ev.provenance) : "User"),
    author_platform: ev.provenance?.platform ?? derivePlatformFromSource(ev.source),
    content: ev.text,
    ...(metadata ? { metadata } : {}),
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
  // A platform is an ingress identity only when the source carries its
  // user-id delimiter. Control injections such as `slack-enter-fallback`
  // must not inherit Slack's relay permissions.
  if (source.startsWith("discord:")) return "discord";
  if (source.startsWith("slack:")) return "slack";
  if (source.startsWith("web")) return "web";
  if (source.startsWith("lictor")) return "lictor";
  return null;
}
