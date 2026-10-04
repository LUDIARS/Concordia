// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SessionMessage, SessionRow } from "../../api.js";
import { SessionChat } from "./SessionChat.js";

vi.mock("../../lib/TeamFilterContext.js", () => ({ useTeamFilter: () => ({ teamId: null }) }));
vi.mock("./ChatInput.js", () => ({ ChatInput: () => <div>メッセージ入力</div> }));

const session: SessionRow = {
  id: "s1", provider: "codex", repo_path: "/repo", repo_origin: null, branch: "work", host: "pc", started_at: 1,
  ended_at: null, status: "active", last_seen_at: 1, current_task: "相談チャット", department_id: "general",
  metadata: { subsidiary_id: "sub" },
};
function message(id: number, author_type: SessionMessage["author_type"], content: string, metadata: SessionMessage["metadata"] = null): SessionMessage {
  return { id, session_id: "s1", ts: id, edited_ts: null, author_type, author_label: author_type,
    author_platform: null, content, metadata, embeds: null, components: null, attachments: null, reference_id: null, dedupe_key: null };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (raw: unknown) => {
    const path = String(raw).split("?")[0];
    let body: unknown;
    if (path === "/v1/sessions") body = { sessions: [session] };
    else if (path === "/v1/sessions/s1") body = { session };
    else if (path === "/v1/subsidiaries") body = { subsidiaries: [{ id: "sub", name: "Child", display_name: "子会社 A" }] };
    else if (path === "/v1/departments") body = { departments: [{ id: "general", subsidiary_id: "sub", name: "総務", effective_output: { intermediate: false, inject_transcript: false } }] };
    else if (path === "/v1/sessions/s1/messages") body = { messages: [message(1, "user", "相談内容"), message(2, "assistant", "途中経過"),
      message(3, "system", "Cc context", { inject_is_cc: true }), message(4, "user", "相談内容", { echo_of_message_id: 1, echo_identity_verified: true }),
      message(5, "assistant", "最終回答", { phase: "final_answer" })] };
    else if (path.endsWith("/chat-attachments")) body = { messages: [] };
    else if (path.endsWith("/unread")) body = { unread: 0 };
    else if (path.endsWith("/read")) body = { ok: true };
    else throw new Error(`Unexpected request: ${String(raw)}`);
    return new Response(JSON.stringify(body));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderChat(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/workplace" element={<SessionChat />} />
    <Route path="/workplace/:id" element={<SessionChat />} />
    <Route path="/sessions/:id" element={<SessionChat />} />
  </Routes></MemoryRouter>);
}

describe("workplace chat", () => {
  it("opens an authorized subsidiary chat from the workplace and applies its effective display settings", async () => {
    const user = userEvent.setup();
    renderChat("/workplace");
    const chat = await screen.findByRole("link", { name: /相談チャット/ });
    await screen.findByText("子会社 A · 総務");
    expect(chat.getAttribute("href")).toBe("/workplace/s1");
    await user.click(chat);
    await screen.findByText("最終回答");
    expect(screen.getAllByText("相談内容")).toHaveLength(1);
    expect(screen.queryByText("途中経過")).toBeNull();
    expect(screen.queryByText("Cc context")).toBeNull();
  });

  it("preserves the existing direct session route", async () => {
    renderChat("/sessions/s1");
    await screen.findByText("最終回答");
    expect(screen.getByRole("link", { name: "ログ" }).getAttribute("href")).toBe("/sessions/s1/logs");
  });
});
