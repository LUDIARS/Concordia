// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("会話ブロック", () => {
  it("人間と AI の発言に異なる役割ラベルと色を付ける", () => {
    const base = toolMessage(null);
    const view = renderItem({ ...base, author_type: "user", content: "依頼" });
    const human = screen.getByRole("article", { name: "プレイヤーのメッセージ" });
    expect(human.className).toContain("emerald");
    view.unmount();
    renderItem({ ...base, author_type: "assistant", content: "回答", metadata: { phase: "final_answer" } });
    expect(screen.getByRole("article", { name: "AIのメッセージ" }).className).toContain("violet");
  });

  it("Cc の注入は閉じたトグルにし、原文を開ける", () => {
    renderItem({ ...toolMessage({ inject_is_cc: true }), author_type: "system", content: "[Cc policy update]\n更新内容" });
    const summary = screen.getByText("Cc 注入").closest("summary");
    const details = summary?.closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("更新内容");
    if (summary) fireEvent.click(summary);
    expect(details?.open).toBe(true);
  });
});
