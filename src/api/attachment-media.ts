/** @implements spec/feature/session-message-webui-chat.md — original media streaming */
import type { FileHandle } from "node:fs/promises";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};

export function attachmentMediaType(extension: string): string | undefined {
  return MEDIA_TYPES[extension.toLowerCase()];
}

/** Takes ownership of the already authorized file handle, including error/cancel paths. */
export async function streamAttachmentMedia(handle: FileHandle, size: number, type: string, range: string | undefined, head: boolean): Promise<Response> {
  const headers = new Headers({ "Content-Type": type, "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  let start = 0;
  let end = size - 1;
  let partial = false;
  let closed = false;
  let cancelled = false;
  const close = async () => { if (!closed) { closed = true; await handle.close(); } };
  try {
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        partial = true;
      }
      if (!partial || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        headers.set("Content-Range", `bytes */${size}`);
        await close();
        return new Response(null, { status: 416, headers });
      }
    }
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    if (head || size === 0) {
      await close();
      return new Response(null, { status: partial ? 206 : 200, headers });
    }
    let position = start;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = Buffer.alloc(Math.min(64 * 1024, end - position + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (closed) return;
          if (!bytesRead) throw new Error("Attachment ended before the requested range");
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
          if (position > end) {
            await close();
            if (!cancelled) controller.close();
          }
        } catch (error) {
          await close();
          if (!cancelled) controller.error(error);
        }
      },
      async cancel() {
        cancelled = true;
        await close();
      },
    });
    return new Response(body, { status: partial ? 206 : 200, headers });
  } catch (error) {
    await close();
    throw error;
  }
}
