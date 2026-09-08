// @vitest-environment jsdom
/** @implements spec/feature/session-message-webui-chat.md — 添付の閲覧 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AttachmentMessageItem, InlineAttachments } from "./Attachments.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("loads text only after expansion and renders markup literally", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ kind: "text", content: "<script>日本語</script>" })));
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<AttachmentMessageItem sessionId="one" message={{ id: 7, ts: 1, author_label: "AI", content: "資料", files: [{ index: 0, name: "memo.md" }] }} />);
  expect(fetcher).not.toHaveBeenCalled();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByText("<script>日本語</script>");
  expect(container.querySelector("script")).toBeNull();
  expect(fetcher.mock.calls[0][0]).toBe("/v1/sessions/one/chat-attachments/7/0");
});

it("aborts a pending preview when it leaves the chat", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    return new Promise(() => { /* Kept pending until component cleanup. */ });
  }));
  const { container, unmount } = render(<AttachmentMessageItem sessionId="one" message={{ id: 1, ts: 1, author_label: "AI", content: "", files: [{ index: 0, name: "memo.md" }] }} />);
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
});

it("does not embed SVG or remote image sources", () => {
  const { container } = render(<InlineAttachments attachments={[
    { kind: "image", media_type: "image/svg+xml", data: "PHN2Zz4=" },
    { kind: "image", media_type: "image/png", data: "https://example.invalid/image.png" },
  ]} />);
  expect(container.querySelector("img")).toBeNull();
});
