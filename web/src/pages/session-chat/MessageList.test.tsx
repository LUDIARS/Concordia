// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { SessionMessage } from "../../api.js";
import { MessageList } from "./MessageList.js";

/**
 * 2026-09-01 の障害: モニターからセッションを開くと画面が真っ黒になり
 * `Uncaught TypeError: q is not a function` が出た。
 *
 * 原因は「useEffect の本体を式のまま書いた」こと。 React は effect の戻り値を
 * cleanup として保存し、 アンマウント / 依存変更時に呼ぶ。 障害が起きた Chromium
 * 環境では `scrollIntoView` が Promise を返したため、 Promise が cleanup として
 * 呼ばれて commitHookEffectListUnmount 内で落ちていた。
 *
 * jsdom は `scrollIntoView` を実装していないので、 ブラウザ側の戻り値を明示的に
 * 差し込んで再現する。
 */

const messages: SessionMessage[] = [
  {
    id: 1,
    session_id: "s1",
    ts: 1_700_000_000,
    edited_ts: null,
    author_type: "user",
    author_label: "User",
    author_platform: null,
    content: "hello",
    embeds: null,
    components: null,
    attachments: null,
    reference_id: null,
    metadata: null,
    dedupe_key: null,
  },
];

function stubScrollIntoView(returnValue: unknown) {
  const prototype = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
  const scrollIntoView = vi.fn(() => returnValue);
  Object.defineProperty(prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
    writable: true,
  });
  return {
    scrollIntoView,
    restore: () => {
      if (original) Object.defineProperty(prototype, "scrollIntoView", original);
      else delete (prototype as { scrollIntoView?: unknown }).scrollIntoView;
    },
  };
}

const noop = async () => {
  // このテストは操作ハンドラを呼ばない。
};

afterEach(() => {
  cleanup();
});

describe("MessageList の自動スクロール", () => {
  it("最終報告の到着で作業を閉じ、最終報告は外に残す", () => {
    const { restore } = stubScrollIntoView(undefined);
    try {
      const progress: SessionMessage = { ...messages[0], id: 2, author_type: "assistant", content: "progress", metadata: { phase: "commentary" } };
      const final: SessionMessage = { ...progress, id: 3, content: "finished", metadata: { phase: "final_answer" } };
      const view = render(<MessageList messages={[...messages, progress]} working onAnswer={noop} onPermission={noop} />);
      expect(view.getByRole("status").textContent).toContain("作業中...");
      view.rerender(<MessageList messages={[...messages, progress, final]} onAnswer={noop} onPermission={noop} />);
      const details = view.container.querySelector("details");
      expect(details?.open).toBe(false);
      expect(details?.textContent).toContain("progress");
      expect(view.getByText("finished").closest("details")).toBeNull();
      expect(view.queryByRole("status")).toBeNull();
    } finally {
      restore();
    }
  });
  it("別保存の添付を折りたたみ内へ移動せず時系列を保つ", () => {
    const { restore } = stubScrollIntoView(undefined);
    try {
      const progress = { ...messages[0], id: 2, ts: 2, author_type: "assistant" as const, content: "progress", metadata: { phase: "commentary" } };
      const tool = { ...messages[0], id: 4, ts: 4, author_type: "tool" as const, content: "tool" };
      const final = { ...progress, id: 5, ts: 5, content: "finished", metadata: { phase: "final_answer" } };
      const attachmentMessages = [{ id: 3, ts: 3, author_label: "User", content: "artifact", files: [] }];
      const view = render(<MessageList messages={[messages[0], progress, tool, final]} attachmentMessages={attachmentMessages} onAnswer={noop} onPermission={noop} />);
      const text = view.container.textContent ?? "";
      expect(text.indexOf("progress")).toBeLessThan(text.indexOf("artifact"));
      expect(text.indexOf("artifact")).toBeLessThan(text.indexOf("tool"));
      expect(view.getByText("artifact").closest("details")).toBeNull();
    } finally {
      restore();
    }
  });
  it("scrollIntoView が Promise を返すブラウザでもアンマウントで落ちない", () => {
    const { restore } = stubScrollIntoView(Promise.resolve());
    try {
      const view = render(<MessageList messages={messages} onAnswer={noop} onPermission={noop} />);
      // cleanup の実体が呼ばれるのはここ。 戻り値を返していると TypeError になる。
      expect(() => view.unmount()).not.toThrow();
    } finally {
      restore();
    }
  });

  it("メッセージが増えたら末尾へスクロールする", () => {
    const { restore, scrollIntoView } = stubScrollIntoView(Promise.resolve());
    try {
      const view = render(<MessageList messages={messages} onAnswer={noop} onPermission={noop} />);
      scrollIntoView.mockClear();

      const next = [...messages, { ...messages[0]!, id: 2, content: "world" }];
      // messages 配列が変わると、再実行の前に前回の cleanup が呼ばれる。
      expect(() => view.rerender(<MessageList messages={next} onAnswer={noop} onPermission={noop} />)).not.toThrow();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    } finally {
      restore();
    }
  });
});
