// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SessionMessage } from "../../api.js";
import { MessageItem } from "./MessageItem.js";

/**
 * neco 指示 (2026-09-01): 「Bash 失敗時に Cc の WebUI で何が失敗したか見れるようにしよう」。
 * 本文は `失敗` の 1 語のままで、 内訳は metadata.failure から出す。
 */

function toolMessage(metadata: Record<string, unknown> | null): SessionMessage {
  return {
    id: 1,
    session_id: "s1",
    ts: 1_700_000_000,
    edited_ts: null,
    author_type: "tool",
    author_label: "Bash",
    author_platform: null,
    content: "失敗",
    embeds: null,
    components: null,
    attachments: null,
    reference_id: null,
    metadata,
    dedupe_key: "frame:1",
  };
}

const noop = async () => { /* このテストは操作ハンドラを呼ばない */ };

function renderItem(message: SessionMessage) {
  return render(
    <MemoryRouter>
      <MessageItem message={message} onAnswer={noop} onPermission={noop} />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("失敗したツール呼び出しの表示", () => {
  it("コマンドとエラー出力を出す", () => {
    renderItem(toolMessage({
      is_error: true,
      failure: { tool: "Bash", command: "npm run build", error: "error TS2554" },
    }));

    expect(screen.getByText(/内容を見る/)).toBeTruthy();
    expect(screen.getByText("npm run build")).toBeTruthy();
    expect(screen.getByText("error TS2554")).toBeTruthy();
  });

  it("コマンドが取れなくてもエラー出力だけ出す", () => {
    renderItem(toolMessage({ is_error: true, failure: { tool: "", command: "", error: "command not found" } }));

    expect(screen.getByText("command not found")).toBeTruthy();
    expect(screen.queryByText("実行した内容")).toBeNull();
  });

  it("内訳の無いツールメッセージは従来どおり 1 行で出す", () => {
    renderItem(toolMessage({ is_error: true }));

    expect(screen.queryByText(/内容を見る/)).toBeNull();
    expect(screen.getByText("失敗")).toBeTruthy();
  });

  it("成功したツールは内訳の面を出さない", () => {
    const message = {
      ...toolMessage({
        is_error: false,
        // A corrected/replayed result can retain older merged metadata. The current
        // outcome remains authoritative and must suppress stale failure details.
        failure: { tool: "Bash", command: "npm run build", error: "old error" },
      }),
      content: "成功",
    };
    renderItem(message);

    expect(screen.queryByText(/内容を見る/)).toBeNull();
    expect(screen.getByText("成功")).toBeTruthy();
  });
});
