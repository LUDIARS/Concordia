import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorkPanel } from "./CloudWorkPanel.js";

vi.mock("../../api.js", () => ({ api: { sessions: vi.fn(async () => ({ sessions: [{ id: "parent", repo_path: "Tokyo2070", status: "active" }] })) } }));
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("response lost");
    if (path.includes("/targets")) return Response.json({ targets: [{ id: "target-1", label: "Codex test", provider: "codex-cloud", ready: true }] });
    return Response.json({ runs: [] });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function chooseSession() {
  await screen.findByText(/Tokyo2070/);
  fireEvent.change(screen.getByLabelText("依頼元"), { target: { value: "parent" } });
  await screen.findByText(/Codex test/);
}

describe("cloud delegation controls", () => {
  it("shows Git review as pending reflection without artifact download links", async () => {
    fetcher.mockImplementation(async (path: string) => path.includes("/targets")
      ? Response.json({ targets: [{ id: "target-1", label: "Codex test", provider: "codex-cloud", transferMode: "git", ready: true }] })
      : Response.json({ runs: [{ attemptId: "git-1", targetId: "target-1", state: "review_submitted", receipt: { state: "submitted" }, reconciliation: null, verified: { state: "review_submitted" } }] }));
    render(<CloudWorkPanel />); await chooseSession();
    expect(await screen.findByText(/Gitで受領し審査へ提出済み（反映前）/)).toBeInTheDocument();
    expect(screen.queryByText(/を保存/)).not.toBeInTheDocument();
  });
  it("keeps a lost submission locked and does not retry on refresh", async () => {
    render(<CloudWorkPanel />); await chooseSession();
    fireEvent.change(screen.getByLabelText("送信先"), { target: { value: "target-1" } });
    fireEvent.change(screen.getByLabelText(/作業タスク/), { target: { value: "actio:task-1" } });
    fireEvent.change(screen.getByLabelText("作ってほしいもの"), { target: { value: "Street terminal" } });
    fireEvent.change(screen.getByLabelText("処理が重い理由"), { target: { value: "Rendering" } });
    fireEvent.change(screen.getByLabelText("AIの判断や操作が必要な理由"), { target: { value: "Inspect model" } });
    fireEvent.click(screen.getByText("クラウドへ依頼する"));
    await screen.findByRole("alert");
    expect(screen.getByText("クラウドへ依頼する")).toBeDisabled();
    fireEvent.click(screen.getByText("状況を確認"));
    await waitFor(() => expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1));
  });
  it("keeps ambiguous persisted work distinct from completion after reloading", async () => {
    fetcher.mockImplementation(async (path: string) => path.includes("/targets")
      ? Response.json({ targets: [{ id: "target-1", label: "Codex test", provider: "codex-cloud", ready: true }] })
      : Response.json({ runs: [{ attemptId: "prior-1", targetId: "target-1", state: "submission_unknown", receipt: { state: "submission_unknown" }, reconciliation: null, verified: null }] }));
    render(<CloudWorkPanel />); await chooseSession();
    expect(await screen.findByText(/受付結果が不明な依頼があります/)).toBeInTheDocument();
    expect(screen.getByText("クラウドへ依頼する")).toBeDisabled();
    expect(screen.queryByText(/を保存/)).not.toBeInTheDocument();
  });
});
