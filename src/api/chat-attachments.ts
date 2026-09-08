/** @implements spec/feature/session-message-webui-chat.md — 添付の閲覧 */
import { Hono } from "hono";
import path from "node:path";
import os from "node:os";
import { open } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import type { ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { buildAttachmentRoots, createAttachmentGuard } from "../shared/attachment-paths.js";
import { configuredAttachmentRoots } from "../config/attachment-policy.js";

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

function attachmentPaths(metadata: string | null): string[] {
  try {
    const value: unknown = JSON.parse(metadata ?? "null")?.attachment_paths;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  } catch { return []; /* Historical malformed metadata has no viewable attachment. */ }
}

export function chatAttachmentsRouter(deps: {
  chat: ChatRepo; sessions: Pick<SessionsRepo, "findSession">; workspaceRoots: () => string[];
}): Hono {
  const app = new Hono();
  app.get("/:id/chat-attachments", (c) => {
    c.header("Cache-Control", "private, no-store");
    const id = c.req.param("id");
    if (!deps.sessions.findSession(id)) return c.json({ error: "not_found" }, 404);
    const messages = deps.chat.list({ sessionId: id, attachmentsOnly: true, limit: 200 }).flatMap((row) => {
      const paths = attachmentPaths(row.metadata);
      return paths.length ? [{ id: row.id, ts: row.ts, author_label: row.author_label, content: row.text,
        files: paths.map((p, index) => ({ index, name: path.basename(p) })) }] : [];
    });
    return c.json({ messages });
  });
  app.get("/:id/chat-attachments/:messageId/:index", async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const id = c.req.param("id");
    if (!deps.sessions.findSession(id)) return c.json({ error: "not_found" }, 404);
    if (!/^\d+$/.test(c.req.param("messageId")) || !/^\d$/.test(c.req.param("index"))) return c.json({ error: "invalid_id" }, 400);
    const row = deps.chat.findById(Number(c.req.param("messageId")));
    if (!row || row.session_id !== id) return c.json({ error: "not_found" }, 404);
    const file = attachmentPaths(row.metadata)[Number(c.req.param("index"))];
    if (!file) return c.json({ error: "not_found" }, 404);
    const guard = createAttachmentGuard({ roots: buildAttachmentRoots({ workspaceRoots: deps.workspaceRoots(), tempDir: os.tmpdir(), configuredRoots: configuredAttachmentRoots() }), enforce: true });
    const checked = await guard.check(file);
    if (!checked.ok) return c.json({ error: "添付が削除されたか、閲覧できない場所にあります" }, 404);
    try {
      const handle = await open(checked.realPath, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return c.json({ error: "not_a_file" }, 400);
        if (stat.size > MAX_PREVIEW_BYTES) return c.json({ error: "8MiBを超える添付は表示できません" }, 413);
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const data = buffer.subarray(0, offset);
        const ext = path.extname(file).toLowerCase();
        const images: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
        if (images[ext]) return c.json({ kind: "image", media_type: images[ext], data: data.toString("base64") });
        if (!isUtf8(data) || data.includes(0)) return c.json({ error: "この形式はテキスト表示できません" }, 415);
        return c.json({ kind: "text", content: data.toString("utf8") });
      } finally { await handle.close(); }
    } catch { return c.json({ error: "添付ファイルを読み込めませんでした" }, 404); }
  });
  return app;
}
