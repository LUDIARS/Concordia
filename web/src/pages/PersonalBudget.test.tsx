// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalBudget } from "./PersonalBudget.js";

afterEach(() => { vi.unstubAllGlobals(); });

const person = {
  id: "pbp_1", subsidiary_id: "sub-glab", platform: "discord", platform_user_id: "123456", display_name: "alice",
  monthly_token_limit_override: null, period: "2026-10", monthly_limit: 1_000_000, monthly_used: 250_000,
  monthly_remaining: 750_000, reward_balance: 300_000,
};
const ledgerEntry = {
  id: "pbl_1", entry_type: "manual", tokens: 300_000, reward_kind: "manual", source_ref: "pbl_1", session_id: null,
  period: null, actor: "discord:900", reason: "勉強会の登壇", notify_state: "delivered", created_at: 1_790_000_000_000,
  updated_at: 1_790_000_000_000,
};

interface Call { url: string; method: string; body: unknown }

function stubApi(overrides: { adjust?: () => Response; total?: number } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, options?: RequestInit) => {
    const url = String(input);
    const method = options?.method ?? "GET";
    calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (url.startsWith("/v1/subsidiaries")) {
      return new Response(JSON.stringify({ subsidiaries: [{ id: "sub-glab", name: "glab", display_name: "GLAB", mode: "subsidiary" }] }));
    }
    if (url.includes("/ledger")) return new Response(JSON.stringify({ entries: [ledgerEntry], total: 1, limit: 20, offset: 0 }));
    if (url.includes("/monthly-limit")) return new Response(JSON.stringify({ person: { id: person.id } }));
    if (url.includes("/adjustments")) {
      return overrides.adjust?.() ?? new Response(JSON.stringify({ person_id: person.id, reward_balance: 800_000 }));
    }
    return new Response(JSON.stringify({ people: [person], total: overrides.total ?? 1, limit: 50, offset: 0 }));
  }));
  return calls;
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<PersonalBudget />); });
  return { container, root };
}

async function unmount(view: { container: HTMLElement; root: Root }): Promise<void> {
  await act(async () => view.root.unmount());
  view.container.remove();
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
}

async function type(container: HTMLElement, ariaLabel: string, value: string): Promise<void> {
  const input = container.querySelector(`input[aria-label="${ariaLabel}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("personal budget page", () => {
  it("shows each person's monthly allowance and reward balance, and loads the ledger only when opened", async () => {
    const calls = stubApi();
    const view = await mount();
    try {
      expect(view.container.textContent).toContain("alice");
      expect(view.container.textContent).toContain("GLAB");
      expect(view.container.textContent).toContain("250,000 / 1,000,000 (残り 750,000)");
      expect(view.container.textContent).toContain("300,000");
      expect(calls.some((call) => call.url.includes("/v1/personal-budget/people?limit=50&offset=0"))).toBe(true);
      expect(calls.some((call) => call.url.includes("/ledger"))).toBe(false);

      await act(async () => { button(view.container, "台帳を見る").click(); });
      expect(calls.some((call) => call.url.includes("/v1/personal-budget/people/pbp_1/ledger?limit=20&offset=0"))).toBe(true);
      expect(view.container.textContent).toContain("勉強会の登壇");
      expect(view.container.textContent).toContain("+300,000");
    } finally {
      await unmount(view);
    }
  });

  it("sends an adjustment with its reason for the selected person", async () => {
    const calls = stubApi();
    const view = await mount();
    try {
      await type(view.container, "調整するトークン数", "500000");
      await type(view.container, "調整の理由", "勉強会の登壇");
      await act(async () => { button(view.container, "調整する").click(); });
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: "/v1/personal-budget/adjustments",
        body: { person_id: "pbp_1", tokens: 500_000, reason: "勉強会の登壇" },
      });
      expect(view.container.textContent).toContain("調整しました (報酬分の残り 800,000)");
    } finally {
      await unmount(view);
    }
  });

  it("does not send an adjustment without a reason", async () => {
    const calls = stubApi();
    const view = await mount();
    try {
      await type(view.container, "調整するトークン数", "-100");
      await act(async () => { button(view.container, "調整する").click(); });
      expect(calls.some((call) => call.method === "POST")).toBe(false);
      expect(view.container.textContent).toContain("理由を入力してください");
    } finally {
      await unmount(view);
    }
  });

  it("shows why the server refused an adjustment", async () => {
    stubApi({
      adjust: () => new Response(
        JSON.stringify({ error: "nothing_to_reduce", message: "報酬分の残りが 0 のため、減額できません。" }),
        { status: 409 },
      ),
    });
    const view = await mount();
    try {
      await type(view.container, "調整するトークン数", "-100");
      await type(view.container, "調整の理由", "訂正");
      await act(async () => { button(view.container, "調整する").click(); });
      expect(view.container.textContent).toContain("報酬分の残りが 0 のため、減額できません。");
    } finally {
      await unmount(view);
    }
  });

  it("saves the monthly limit override, and clears it with an empty field", async () => {
    const calls = stubApi();
    const view = await mount();
    try {
      await type(view.container, "月間分の上限の上書き", "250000");
      await act(async () => { button(view.container, "上限を保存").click(); });
      expect(calls.find((call) => call.method === "PUT")).toMatchObject({
        url: "/v1/personal-budget/people/pbp_1/monthly-limit", body: { monthly_token_limit: 250_000 },
      });

      await type(view.container, "月間分の上限の上書き", "");
      await act(async () => { button(view.container, "上限を保存").click(); });
      expect(calls.filter((call) => call.method === "PUT").at(-1)!.body).toEqual({ monthly_token_limit: null });
    } finally {
      await unmount(view);
    }
  });

  it("pages the list", async () => {
    const calls = stubApi({ total: 120 });
    const view = await mount();
    try {
      expect(view.container.textContent).toContain("1–50 / 120 人");
      expect(button(view.container, "前へ").disabled).toBe(true);
      await act(async () => { button(view.container, "次へ").click(); });
      expect(calls.some((call) => call.url.includes("limit=50&offset=50"))).toBe(true);
    } finally {
      await unmount(view);
    }
  });
});
