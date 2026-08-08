/** Transport- and storage-neutral types for the canonical session message stream. */

export type SessionMessageAuthorType =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "task"
  | "system"
  | "delegation"
  | "question"
  | "permission"
  | "summary";

export interface EmbedField {
  name: string;
  value: string;
}

export interface Embed {
  title?: string;
  description?: string;
  fields?: EmbedField[];
  color?: number;
}

export interface Component {
  kind: string;
  [key: string]: unknown;
}

export interface Attachment {
  kind: "image";
  media_type: string;
  data: string;
}

export interface SessionMessagePayload {
  id: number;
  session_id: string;
  ts: number;
  edited_ts: number | null;
  author_type: SessionMessageAuthorType;
  author_label: string;
  author_platform: string | null;
  content: string;
  embeds: Embed[] | null;
  components: Component[] | null;
  attachments: Attachment[] | null;
  reference_id: number | null;
  metadata: Record<string, unknown> | null;
  dedupe_key: string | null;
}
