// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { InboxItem, InboxResult } from "../api.js";
import { Inbox } from "./Inbox.js";

const apiMocks = vi.hoisted(() => ({
  inbox: vi.fn(),
  inboxMarkRead: vi.fn(),
  inboxSnooze: vi.fn(),
}));

vi.mock("../api.js", () => ({ api: apiMocks }));
vi.mock("../lib/client-id.js", () => ({ clientId: () => "browser-1" }));

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    key: "ask-card:1",
    kind: "ask-card",
    summary: "答えて",
    raised_at: 1,
    elapsed_ms: 60_000,
    session_id: "session-1",
    case_id: null,
    repo_origin: null,
    pr_number: null,
    read_at: null,
    snoozed_until: null,
    snoozed: false,
    ...over,
  };
}

function result(items: InboxItem[]): InboxResult {
  return {
    count: items.length,
    active_count: items.filter((entry) => !entry.snoozed).length,
    items,
  };
}

function renderInbox() {
  return render(<MemoryRouter><Inbox /></MemoryRouter>);
}

beforeEach(() => {
  apiMocks.inbox.mockReset();
  apiMocks.inboxMarkRead.mockReset().mockResolvedValue({ ok: true });
  apiMocks.inboxSnooze.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("Inbox", () => {
  it("一覧を表示し、既読操作後に再取得する", async () => {
    apiMocks.inbox.mockResolvedValue(result([item()]));
    const user = userEvent.setup();
    renderInbox();

    expect(await screen.findByText("答えて")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "セッションで答える" }).getAttribute("href"),
    ).toBe("/sessions/session-1");

    await user.click(screen.getByRole("button", { name: "既読にする" }));

    await waitFor(() => {
      expect(apiMocks.inboxMarkRead).toHaveBeenCalledWith("browser-1", "ask-card:1", true);
    });
    await waitFor(() => expect(apiMocks.inbox).toHaveBeenCalledTimes(2));
  });

  it("初回取得に失敗した後は読み込み中と表示し続けない", async () => {
    apiMocks.inbox.mockRejectedValue(new Error("offline"));
    renderInbox();

    expect(await screen.findByText("読み込みに失敗しました: offline")).not.toBeNull();
    expect(screen.queryByText("読み込み中…")).toBeNull();
  });
});
