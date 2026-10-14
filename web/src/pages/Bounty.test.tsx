// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bounty } from "./Bounty.js";

afterEach(() => { vi.unstubAllGlobals(); });

const summary = {
  id: "br_0123456789", status: "fix_pending", project: "Cc", company: "sub-glab", severity: "s2", verdict: "accepted",
  reporter: "neco (discord:905 @sub-glab)", recipient: "neco (discord:905 @sub-glab)", actio_task_ref: "actio:t-1",
  actio_task_error: null, fix_pr: null, deployed_at: null, received_at: 1_790_000_000_000, public_title: "スレッドが作られない",
  needs_attention: null, event_id: "be_a",
};
const bountyEvent = {
  id: "be_a", title: "秋のバグ探し", starts_at: 1_790_000_000_000, ends_at: 1_790_600_000_000, projects: ["Cc"],
  channels: ["discord", "session"], guidance: "", reward_override: { s1: 3_000_000 }, ended_early_at: null, ended_by: null,
  created_by: "webui-admin", created_at: 1, updated_at: 1, phase: "open",
};
const detail = {
  ...summary, what_happened: "原文の本文", repro_steps: "/spawn", intake_platform: "discord", verdict_reason: "再現した",
  sensitive: false, self_inflicted: false, hotfix_eligible: false, duplicate_of: null, public_summary: "要約",
  deploy: { code: null, hash: null, evidence: null, closed_by: null },
  triage: { run_id: null, failures: 0, escalated_at: null, triaged_at: 1_790_000_000_100 },
  appeal: { requested_at: null, reason: null, decided_at: null },
  hotfix: { run_id: null, started_at: null },
  reward: { state: null, tokens: null, note: null },
  events: [{ id: 1, kind: "received", from_value: null, to_value: "received", actor_kind: "human", actor_id: "bp_1", created_at: 1_790_000_000_000 }],
};

interface Call { url: string; method: string; body: unknown }

function stubApi(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, options?: RequestInit) => {
    const url = String(input);
    const method = options?.method ?? "GET";
    calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (url.startsWith("/v1/subsidiaries")) return new Response(JSON.stringify({ subsidiaries: [] }));
    if (url.startsWith("/v1/bounty/events")) return new Response(JSON.stringify({ events: [bountyEvent] }));
    if (url.startsWith("/v1/admin/bounty/cocoiru-key")) return new Response(JSON.stringify({ configured: false }));
    if (url.startsWith("/v1/admin/bounty/")) return new Response(JSON.stringify({ ok: true }));
    if (url.startsWith(`/v1/bounty/reports/${summary.id}`)) return new Response(JSON.stringify({ report: detail }));
    return new Response(JSON.stringify({ reports: [summary], total: 1, limit: 50, offset: 0, hotfix_daily_limit: 5 }));
  }));
  return calls;
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter><Bounty /></MemoryRouter>); });
  return { container, root };
}

describe("Bounty page (bug-bounty.md §8.2)", () => {
  it("lists reports without their text and opens the detail with the text, history and authority actions", async () => {
    const calls = stubApi();
    const view = await mount();
    expect(view.container.textContent).toContain("br_0123456789");
    expect(view.container.textContent).toContain("修正待ち");
    expect(view.container.textContent).not.toContain("原文の本文");
    expect(view.container.textContent).toContain("5 件");
    // 企画の一覧と、報告の行の企画名 (bug-bounty.md §18)。
    expect(view.container.textContent).toContain("企画: 秋のバグ探し");
    expect(view.container.textContent).toContain("s1: 3000000");

    const eventFilter = [...view.container.querySelectorAll("select")].find((select) => select.textContent?.includes("企画外"))!;
    await act(async () => {
      eventFilter.value = "be_a";
      eventFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls.some((call) => call.url.startsWith("/v1/bounty/reports?") && call.url.includes("event=be_a"))).toBe(true);

    const row = [...view.container.querySelectorAll("tr")].find((tr) => tr.textContent?.includes("br_0123456789"))!;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(view.container.textContent).toContain("原文の本文");
    expect(view.container.textContent).toContain("反映済みとして閉じる");

    const evidence = view.container.querySelector('input[placeholder="閉じる根拠 (反映を確認した事実)"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(evidence, "本番で確認");
      evidence.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const close = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "反映済みとして閉じる")!;
    await act(async () => { close.click(); });
    expect(calls).toContainEqual({ url: `/v1/admin/bounty/reports/${summary.id}/close`, method: "POST", body: { evidence: "本番で確認" } });

    await act(async () => view.root.unmount());
    view.container.remove();
  });
});
