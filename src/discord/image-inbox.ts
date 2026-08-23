import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INBOX_DIR_NAME = "concordia-discord-image-inbox";

const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const EXTENSION_BY_MIME = new Map([
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

export interface DiscordImageAttachment {
  contentType: string | null;
  name: string | null;
  size: number;
  url: string;
}

export interface StoreDiscordImagesInput {
  attachments: readonly DiscordImageAttachment[];
  fetchImpl?: typeof fetch;
  inboxRoot?: string;
  messageId: string;
  now?: () => number;
  sessionId: string;
}

class DiscordImageInboxError extends Error {}

export function isDiscordImageAttachment(attachment: DiscordImageAttachment): boolean {
  const contentType = normalizeContentType(attachment.contentType);
  if (contentType.startsWith("image/")) return true;
  return /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(attachment.name ?? "");
}

export function publicDiscordImageError(error: unknown): string {
  if (error instanceof DiscordImageInboxError) return error.message;
  return "画像の取得または保存中に内部エラーが発生しました";
}

export async function storeDiscordImages(input: StoreDiscordImagesInput): Promise<string[]> {
  if (input.attachments.length === 0) return [];
  if (input.attachments.length > MAX_IMAGES) {
    throw new DiscordImageInboxError(`画像は1投稿につき${MAX_IMAGES}枚までです`);
  }

  const root = input.inboxRoot ?? join(tmpdir(), INBOX_DIR_NAME);
  const now = input.now ?? Date.now;
  await ensureInboxRoot(root);
  await pruneExpiredImages(root, now()).catch(() => {
    // Cleanup is best-effort. A stale file must not prevent a new image from reaching the session.
  });

  return storeImageBatch({
    attachments: input.attachments,
    fetchImpl: input.fetchImpl ?? fetch,
    messageId: input.messageId,
    root,
    sessionId: input.sessionId,
  });
}

async function storeImageBatch(input: {
  attachments: readonly DiscordImageAttachment[];
  fetchImpl: typeof fetch;
  messageId: string;
  root: string;
  sessionId: string;
}): Promise<string[]> {
  const saved: Array<{ created: boolean; path: string }> = [];
  try {
    for (const [index, attachment] of input.attachments.entries()) {
      saved.push(await storeOneImage({
        attachment,
        fetchImpl: input.fetchImpl,
        index,
        messageId: input.messageId,
        root: input.root,
        sessionId: input.sessionId,
      }));
    }
  } catch (error) {
    await Promise.all(saved.filter(({ created }) => created).map(({ path }) => unlink(path).catch(() => {
      // A failed batch must not retain newly downloaded images; cleanup remains best-effort.
    })));
    throw error;
  }
  return saved.map(({ path }) => path);
}

export function buildDiscordImageInjectText(text: string, imagePaths: readonly string[]): string {
  if (imagePaths.length === 0) return text;
  const instruction = text || "添付画像の内容を読み取って対応してください。";
  return [
    instruction,
    "",
    "Discordから受信した画像を次のローカルパスへ保存しました。画像読取機能で実物を確認してから対応してください:",
    ...imagePaths.map((path) => `- ${path}`),
  ].join("\n");
}

async function storeOneImage(input: {
  attachment: DiscordImageAttachment;
  fetchImpl: typeof fetch;
  index: number;
  messageId: string;
  root: string;
  sessionId: string;
}): Promise<{ created: boolean; path: string }> {
  const rawDeclaredType = normalizeContentType(input.attachment.contentType);
  const declaredType = EXTENSION_BY_MIME.has(rawDeclaredType) ? rawDeclaredType : "";
  if (rawDeclaredType.startsWith("image/") && !declaredType) {
    throw new DiscordImageInboxError("対応していない画像形式です（PNG/JPEG/GIF/WebPのみ）");
  }
  if (input.attachment.size <= 0 || input.attachment.size > MAX_IMAGE_BYTES) {
    throw new DiscordImageInboxError(`画像サイズが不正です（上限${MAX_IMAGE_BYTES / 1024 / 1024} MiB）`);
  }

  let url: URL;
  try {
    url = new URL(input.attachment.url);
  } catch {
    throw new DiscordImageInboxError("画像URLが不正です");
  }
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new DiscordImageInboxError("Discord CDN以外の画像URLは受け付けられません");
  }

  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new DiscordImageInboxError("Discordから画像を取得できませんでした");
  }
  if (!response.ok) throw new DiscordImageInboxError(`画像の取得に失敗しました（HTTP ${response.status}）`);

  const rawResponseType = normalizeContentType(response.headers.get("content-type"));
  const responseType = EXTENSION_BY_MIME.has(rawResponseType) ? rawResponseType : "";
  if (rawResponseType && !responseType && rawResponseType !== "application/octet-stream") {
    throw new DiscordImageInboxError("対応していない画像形式です（PNG/JPEG/GIF/WebPのみ）");
  }
  // 形式は実体のマジックバイトだけを正とする。Discord が contentType を欠いた添付
  // (isDiscordImageAttachment がファイル名だけで通したもの) もここで確定でき、申告値・
  // ダウンロード結果・実体の三者不一致をまとめて弾ける。
  const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);
  const actualType = detectImageMime(bytes);
  const extension = actualType ? EXTENSION_BY_MIME.get(actualType) : undefined;
  if (!actualType || !extension) throw new DiscordImageInboxError("対応していない画像形式です（PNG/JPEG/GIF/WebPのみ）");
  if ((declaredType && declaredType !== actualType) || (responseType && responseType !== actualType)) {
    throw new DiscordImageInboxError("画像の内容とContent-Typeが一致しません");
  }

  const prefix = `${safeId(input.sessionId)}-${safeId(input.messageId)}-${input.index + 1}`;
  const target = join(input.root, `${prefix}${extension}`);
  const temporary = join(input.root, `${prefix}.${randomUUID()}.part`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    let created = false;
    try {
      // Publish a fully written file without replacing an earlier delivery.
      await link(temporary, target);
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await unlink(temporary);
    return { created, path: target };
  } catch (error) {
    await unlink(temporary).catch(() => { /* best-effort partial-file cleanup */ });
    throw error;
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new DiscordImageInboxError("画像レスポンスの本文がありません");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let drained = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new DiscordImageInboxError(`画像が大きすぎます（上限${maxBytes / 1024 / 1024} MiB）`);
      chunks.push(value);
    }
    drained = true;
  } finally {
    // 上限超過で打ち切った本文は cancel しないと下層の接続が読み残しのまま滞留する。
    if (!drained) await reader.cancel().catch(() => { /* teardown is best-effort */ });
    reader.releaseLock();
  }
  if (total === 0) throw new DiscordImageInboxError("画像が空です");
  return Buffer.concat(chunks, total);
}

async function ensureInboxRoot(root: string): Promise<void> {
  // A fixed directory beneath a shared POSIX /tmp must be owned by this process user and
  // must never be a symlink. chmod also repairs permissions on an inbox from an older run.
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DiscordImageInboxError("画像保存先を安全に準備できませんでした");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new DiscordImageInboxError("画像保存先を安全に準備できませんでした");
    }
    await chmod(root, 0o700);
  }
}

async function pruneExpiredImages(root: string, now: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const path = join(root, basename(entry.name));
    const info = await stat(path);
    if (now - info.mtimeMs > RETENTION_MS) await unlink(path);
  }));
}

function detectImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function safeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return normalized || "unknown";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
