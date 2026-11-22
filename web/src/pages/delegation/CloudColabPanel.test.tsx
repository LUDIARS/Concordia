// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
// Register jest-dom on this file's expect (same as Inbox.test.tsx). The "@testing-library/jest-dom/vitest" entry
// imports vitest from web/node_modules, which differs from the root runner's vitest.
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { CloudColabPanel } from "./CloudColabPanel.js";
expect.extend(jestDomMatchers);

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

it("shows the site readiness reason and directs the owner to Colab when release is unknown", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.includes("/targets")
    ? Response.json({ targets: [{ id: "gromac", label: "GROMAC", destination: "owner", gpu: "T4", maxSeconds: 300,
      transport: "excubitor-site", ready: false, reason: "cloud_colab_site_mesh_not_ready" }] })
    : Response.json({ runs: [{ attemptId: "attempt", targetId: "gromac", providerTerminal: "unknown",
      resourceRelease: "unknown", sitePhase: "release_unknown", stopProgress: "requested", qualityAcceptance: "pending",
      deadlineAt: 1800000000000, stopReason: null, error: null, workerReport: null, artifactVerification: null }] })));
  render(<CloudColabPanel sessionId="session-1" taskReference="actio:task-1" />);
  expect(await screen.findByText(/拠点間の認証設定/)).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(/実行枠を保持.*ランタイム管理画面/);
  expect(screen.getByRole("button", { name: "Colab の停止を依頼" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Colab を開始" })).toBeDisabled();
});
