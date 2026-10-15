// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rules } from "./Rules.js";
import { parseDiscordChannel } from "./rules/RuleEditor.js";

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

const patrolRule = {
  id: "tendentia-tech-patrol", description: "IT の話題", trigger_type: "tick", tick_sec: 1800, event_kind: null,
  instructions: "短く", target: "chitchat", cooldown_sec: 1800, enabled: false, added_by: "human", removed_at: null,
  config_version: 2, revision: 3, execution_mode: "patrol",
  action_config: {
    kind: "material-chat", source_ids: ["tendentia-public-trends"], scope_key: "hq",
    filters: { genres: ["tech"], max_age_sec: 86400 }, renderer: "oneshot", max_chars: 240,
    root_limit_per_day: 8, llm_limit_per_day: 16,
    followup: { reply_enabled: true, reaction_threshold: 3, later_message_threshold: 4, min_wait_sec: 600, window_sec: 21600, max_unprompted: 1, max_replies: 4 },
  },
  next_due_at: null, last_attempt_at: null, last_posted_at: null,
  readiness: { runnable: false, reason: "disabled" },
  last_run: { run_id: "run-1", status: "delivery_unknown", reason: null, created_at: 1 },
};
const legacyRule = {
  ...patrolRule, id: "default-tick", config_version: 1, revision: 1, execution_mode: "legacy-observe", action_config: null,
  enabled: true, readiness: { runnable: false, reason: "legacy-observe (投稿しない旧 rule)" }, last_run: null,
};

interface Call { url: string; method: string; body: any }

function stub(overrides: { patch?: () => Response; subsidiaries?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, options?: RequestInit) => {
    const url = String(input);
    const method = options?.method ?? "GET";
    calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (url === "/v1/rules" && method === "GET") return new Response(JSON.stringify({ rules: [patrolRule, legacyRule] }));
    if (url === "/v1/rules?subsidiary_id=sub-glab") return new Response(JSON.stringify({ rules: [{ ...patrolRule, id: "glab-trend-1", subsidiary_id: "sub-glab" }] }));
    if (url === "/v1/subsidiaries") {
      return overrides.subsidiaries
        ? new Response(JSON.stringify({ subsidiaries: [{ id: "sub-glab", name: "glab", display_name: "GLab", enabled: true }] }))
        : new Response("{}", { status: 404 });
    }
    if (url === "/v1/subsidiaries/sub-glab/patrol-defaults" && method === "GET") {
      return new Response(JSON.stringify({ defaults: { quiet_hours: { start: "22:00", end: "09:30" } }, updated_at: 1, updated_by: "discord:1" }));
    }
    if (url === "/v1/subsidiaries/sub-glab/patrol-defaults" && method === "PUT") {
      return new Response(JSON.stringify({ defaults: {} }));
    }
    if (url === "/v1/rules/sources") {
      return new Response(JSON.stringify({ sources: [
        { sourceId: "tendentia-public-trends", label: "Tendentia 公開トレンド", kind: "trend", serviceCode: "Td", scopes: ["*"], status: "ready", reason: null, lastFetchedAt: null, lastError: null },
        { sourceId: "corpus-activity", label: "Corpus 継承サービスの活動ログ", kind: "activity", serviceCode: "Co", scopes: [], status: "unavailable", reason: "contract-unverified", lastFetchedAt: null, lastError: null },
      ] }));
    }
    if (url === "/v1/admin/rules-enabled") return new Response(JSON.stringify({ enabled: false }));
    if (url.startsWith("/v1/rules/tendentia-tech-patrol") && method === "PATCH") {
      return overrides.patch?.() ?? new Response(JSON.stringify({ rule: { ...patrolRule, revision: 4 } }));
    }
    if (url === "/v1/rules/preview") {
      return new Response(JSON.stringify({ preview: { ok: false, reason: "no material", seed: 5, candidateCount: 0, scored: [], picked: null, sourceErrors: [] } }));
    }
    if (url.startsWith("/v1/rules/runs?")) {
      return new Response(JSON.stringify({ runs: [{
        run_id: "run-1", rule_id: "tendentia-tech-patrol", rule_revision: 3, trigger_key: "tick:x", action_kind: "pick",
        conversation_id: null, scope_key: "hq", channel: "chitchat", source_ref: "hn:k1", material: { title: "New compiler" },
        seed: 1, decision: { candidateCount: 2 }, reason: null, status: "delivery_unknown", render_attempts: 1, llm_calls: 1,
        rendered_text: "速いコンパイラ", chat_message_id: 9, delivery_ref: null, error_code: null, created_at: 1, updated_at: 1,
      }], next_cursor: null }));
    }
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

async function render(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Rules />); });
  await act(async () => { await Promise.resolve(); });
  return { root, container };
}

const click = async (el: Element | null | undefined) => {
  await act(async () => { (el as HTMLElement).click(); });
  await act(async () => { await Promise.resolve(); });
};
const byText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);

describe("parseDiscordChannel", () => {
  it("takes the channel ID from a Discord channel URL or a bare ID", () => {
    expect(parseDiscordChannel("https://discord.com/channels/1352438523155841126/1546109590930853962")).toBe("1546109590930853962");
    expect(parseDiscordChannel(" 1546109590930853962 ")).toBe("1546109590930853962");
    expect(parseDiscordChannel("chitchat")).toBeNull();
  });
});

describe("Rules page", () => {
  it("shows engine state, source availability and labels legacy rules as non-posting", async () => {
    stub();
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="engine-state"]')?.textContent).toBe("OFF");
    expect(container.querySelector('[data-testid="source-corpus-activity"]')?.textContent).toContain("contract-unverified");
    expect(container.querySelector('[data-testid="rule-row-default-tick"]')?.textContent).toContain("legacy-observe (投稿しない)");
    expect(container.querySelector('[data-testid="rule-row-tendentia-tech-patrol"]')?.textContent).toContain("配達結果不明");
    act(() => root.unmount());
  });

  it("edits with expected_revision and explains a revision conflict", async () => {
    const calls = stub({ patch: () => new Response(JSON.stringify({ error: "revision_conflict", revision: 4 }), { status: 409 }) });
    const { container, root } = await render();
    await click(container.querySelector('[data-testid="rule-row-tendentia-tech-patrol"]')?.querySelectorAll("button")[2]);
    expect(container.querySelector('[data-testid="rule-editor"]')).not.toBeNull();
    await click(byText(container, "保存"));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({ expected_revision: 3, config_version: 2 });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/競合/);
    act(() => root.unmount());
  });

  it("filters by subsidiary owner and edits that subsidiary's defaults", async () => {
    const calls = stub({ subsidiaries: true });
    const { container, root } = await render();
    const select = container.querySelector('select[aria-label="持ち主"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => {
      select.value = "sub-glab";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(calls.some((c) => c.url === "/v1/rules?subsidiary_id=sub-glab")).toBe(true);
    const panel = container.querySelector('[data-testid="subsidiary-defaults"]');
    expect(panel?.textContent).toContain("GLab の既定値");
    expect((panel?.querySelector('input[aria-label="既定の開始"]') as HTMLInputElement).value).toBe("22:00");
    await click(byText(container, "既定値を保存"));
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/patrol-defaults"))!;
    expect(put.body).toMatchObject({ actor: "web", defaults: { quiet_hours: { start: "22:00", end: "09:30" } } });
    act(() => root.unmount());
  });

  it("hides the owner filter when subsidiaries are unavailable", async () => {
    stub();
    const { container, root } = await render();
    expect(container.querySelector('select[aria-label="持ち主"]')).toBeNull();
    act(() => root.unmount());
  });

  it("previews without posting and lists runs with delivery state", async () => {
    stub();
    const { container, root } = await render();
    await click(byText(container, "試し見"));
    expect(container.querySelector('[data-testid="rule-preview"]')?.textContent).toContain("no material");
    await click(byText(container, "実行履歴"));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="run-list"]')?.textContent).toContain("速いコンパイラ");
    expect(container.querySelector('[data-testid="run-list"]')?.textContent).toContain("配達結果不明");
    act(() => root.unmount());
  });
});
