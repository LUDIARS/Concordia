// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { SessionRow } from "../../api.js";
import { SessionList } from "./SessionList.js";
import { sessionCategories } from "./session-categories.js";

const session = (id: string, metadata: SessionRow["metadata"] = null): SessionRow => ({
  id, provider: "codex", repo_path: "/repo", repo_origin: null, branch: "main", host: "pc", started_at: 1,
  ended_at: null, status: "active", last_seen_at: 1, current_task: id, metadata,
});

afterEach(cleanup);

describe("workplace session categories", () => {
  it("includes authorized subsidiary chats and classifies only an explicit taskflow category", () => {
    const groups = sessionCategories([session("head"), session("child", { subsidiary_id: "sub" }),
      { ...session("task"), category: "taskflow" }, session("taskflow in a title")], [],
    [{ id: "sub", name: "Subsidiary", display_name: "子会社 A" }]);
    expect(groups.find((group) => group.label === "子会社 A · 未配属")?.sessions.map((item) => item.id)).toEqual(["child"]);
    expect(groups.find((group) => group.id === "taskflow")).toMatchObject({ defaultOpen: false, sessions: [{ id: "task" }] });
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(4);
  });

  it("keeps task workflow closed until toggled, exposes unread counts and uses workplace links", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SessionList sessions={[session("会話"), { ...session("ワークフロー"), category: "taskflow" }]}
      unread={new Map([["ワークフロー", 3]])} basePath="/workplace" /></MemoryRouter>);
    const toggle = screen.getByRole("button", { name: /タスクワークフロー/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: /ワークフロー/ })).toBeNull();
    expect(screen.getByLabelText("未読 3 件")).toBeTruthy();
    await user.click(toggle);
    expect(screen.getByRole("link", { name: /ワークフロー/ }).getAttribute("href")).toBe(`/workplace/${encodeURIComponent("ワークフロー")}`);
    await user.type(screen.getByLabelText("チャットを検索"), "会話");
    expect(screen.queryByRole("button", { name: /タスクワークフロー/ })).toBeNull();
  });
});
