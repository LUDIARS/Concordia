// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
// Register jest-dom on this file's expect (same as Inbox.test.tsx). The "@testing-library/jest-dom/vitest" entry
// imports vitest from web/node_modules, which differs from the root runner's vitest.
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { CloudAwsPanel } from "./CloudAwsPanel.js";
expect.extend(jestDomMatchers);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the MCP proposal and requires a separate human confirmation", async () => {
  const proposal = { attemptId: "proposed", taskReference: "actio:task", targetId: "registered", runner: "build",
    deadline: new Date(Date.now() + 600_000).toISOString(), expiresAt: Date.now() + 600_000, inputs: { TEST_MODE: "short" },
    evidence: { code: "public", data: "non_confidential", destination: "approved" } };
  const run = { ...proposal, receipt: {}, exitCode: null, resourceRelease: "unknown", providerTerminal: "unknown",
    stopProgress: "none", artifactVerification: null, submission: "unknown" };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json(run);
    if (path.includes("/proposals")) return Response.json({ proposals: [proposal] });
    if (path.includes("/targets")) return Response.json({ targets: [] });
    return Response.json({ runs: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<CloudAwsPanel sessionId="parent" taskReference="actio:task" />);
  fireEvent.change(await screen.findByLabelText("MCP 開始案"), { target: { value: "proposed" } });
  expect(screen.getByText("short")).toBeInTheDocument();
  expect(screen.getByText("AWS を開始")).toBeDisabled();
  fireEvent.click(screen.getByText(/公開コードと非機密入力/));
  fireEvent.click(screen.getByText("AWS を開始"));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
  const sent = fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
  expect(JSON.parse(String(sent?.body))).toMatchObject({ attemptId: "proposed", session_id: "parent", proposal: true, ownerApproved: true });
  expect(await screen.findByText(/受付未確認/)).toBeInTheDocument();
});
