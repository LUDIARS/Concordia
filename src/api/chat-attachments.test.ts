/** @implements spec/feature/session-message-webui-chat.md — 添付の閲覧 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeTestDb, makeTestDir } from "../../tests/helpers/db.js";
import { ChatRepo } from "../db/chat-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { chatAttachmentsRouter } from "./chat-attachments.js";

function fixture() {
  const db = makeTestDb();
  const chat = new ChatRepo(db);
  const sessions = new SessionsRepo(db);
  const dir = makeTestDir("cc-attachment-preview-");
  for (const id of ["one", "two"]) sessions.insertSession({ id, provider: "codex-cli", repo_path: dir,
    repo_origin: null, branch: null, host: "test", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
  const app = chatAttachmentsRouter({ chat, sessions, workspaceRoots: () => [dir] });
  const attach = (name: string, content: string | Buffer) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return chat.insert({ channel: "system", session_id: "one", author_label: "AI", text: "資料",
      in_reply_to: null, is_actionable: false, metadata: JSON.stringify({ attachment_paths: [file] }) });
  };
  return { app, attach, dir };
}

describe("recorded chat attachment preview", () => {
  it("lists only the selected session and keeps local paths private", async () => {
    const { app, attach, dir } = fixture();
    const row = attach("資料.md", "# 日本語");
    const response = await app.request("/one/chat-attachments");
    const body = await response.json();
    expect(body.messages).toEqual([expect.objectContaining({ id: row.id, files: [{ index: 0, name: "資料.md" }] })]);
    expect(JSON.stringify(body)).not.toContain(dir);
    expect(await (await app.request("/two/chat-attachments")).json()).toEqual({ messages: [] });
  });

  it("preserves UTF-8 and markup as text with no-store", async () => {
    const { app, attach } = fixture();
    const content = "# 日本語\n<script>alert(1)</script>";
    const row = attach("preview.md", content);
    const response = await app.request(`/one/chat-attachments/${row.id}/0`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ kind: "text", content });
  });

  it("rejects cross-session, unrecorded and secret files", async () => {
    const { app, attach } = fixture();
    const row = attach(".env", "SECRET=value");
    for (const url of [`/two/chat-attachments/${row.id}/0`, `/one/chat-attachments/${row.id}/1`, `/one/chat-attachments/${row.id}/0`]) {
      expect((await app.request(url)).status).toBe(404);
    }
  });

  it("returns raster image bytes without a filesystem URL", async () => {
    const { app, attach } = fixture();
    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=", "base64");
    const row = attach("preview.png", data);
    expect(await (await app.request(`/one/chat-attachments/${row.id}/0`)).json()).toEqual({ kind: "image", media_type: "image/png", data: data.toString("base64") });
  });

  it("streams allowlisted media with byte ranges and HEAD metadata", async () => {
    const { app, attach } = fixture();
    const row = attach("clip.mp4", "0123456789");
    const url = `/one/chat-attachments/${row.id}/0?raw=1`;
    const partial = await app.request(url, { headers: { Range: "bytes=2-5" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("video/mp4");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(partial.headers.get("cache-control")).toContain("no-store");
    expect(partial.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await partial.text()).toBe("2345");

    const head = await app.request(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");

    const unsatisfied = await app.request(url, { headers: { Range: "bytes=10-" } });
    expect(unsatisfied.status).toBe(416);
    expect(unsatisfied.headers.get("content-range")).toBe("bytes */10");
  });

  it("does not expose non-media files through the raw response", async () => {
    const { app, attach } = fixture();
    const row = attach("notes.txt", "private notes");
    expect((await app.request(`/one/chat-attachments/${row.id}/0?raw=1`)).status).toBe(415);
  });

  it("rejects binary text and bounds large file reads", async () => {
    const { app, attach } = fixture();
    const binary = attach("binary.txt", Buffer.from([0, 255]));
    const large = attach("large.txt", Buffer.alloc(8 * 1024 * 1024 + 1));
    expect((await app.request(`/one/chat-attachments/${binary.id}/0`)).status).toBe(415);
    expect((await app.request(`/one/chat-attachments/${large.id}/0`)).status).toBe(413);
  });
});
