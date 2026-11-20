// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudColabPanel } from "./CloudColabPanel.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("requires an explicit owner confirmation for the displayed destination and keeps an unknown attempt", async () => {
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("受付結果を確認できません");
    return _path.includes("/targets") ? Response.json({ targets: [{
      id: "colab", label: "試行", destination: "owner-drive", gpu: "T4", maxSeconds: 600, ready: true,
    }] }) : Response.json({ runs: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<CloudColabPanel sessionId="session-1" taskReference="actio:task-1" />);
  fireEvent.change(await screen.findByLabelText("登録済みの実行先"), { target: { value: "colab" } });
  expect(screen.getByText("Colab を開始")).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("Colab を開始"));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("Colab を開始")).toBeDisabled();
  fireEvent.click(screen.getByText("Colab の状況を確認"));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
  const [, sent] = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(sent?.body))).toMatchObject({ ownerApproved: true,
    evidence: { code: "public", data: "non_confidential", destination: "owner-drive" } });
});
