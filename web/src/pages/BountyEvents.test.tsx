// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BountyEvent } from "../api.js";
import { BountyEvents, toEventInput, toLocalInput } from "./BountyEvents.js";

afterEach(() => { vi.unstubAllGlobals(); });

const openEvent: BountyEvent = {
  id: "be_a", title: "秋のバグ探し", starts_at: 1_790_000_000_000, ends_at: 1_790_600_000_000, projects: ["Cc", "Ar"],
  channels: ["discord", "session"], guidance: "通知まわり", reward_override: { s2: 700_000 }, ended_early_at: null, ended_by: null,
  created_by: "webui-admin", created_at: 1, updated_at: 1, phase: "open",
};

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("BountyEvents (bug-bounty.md §8.2 §18)", () => {
  it("converts the form to the API shape and leaves blank overrides to the defaults", () => {
    const starts = toLocalInput(1_790_000_000_000);
    expect(new Date(starts).getTime()).toBe(1_790_000_000_000 - (1_790_000_000_000 % 60_000));
    expect(toEventInput({
      title: " 秋 ", starts, ends: toLocalInput(1_790_600_000_000), projects: "Cc, Ar、At", channels: ["discord"], guidance: " g ",
      override: { s1: "", s2: "700000", s3: " ", s4: "" },
    })).toMatchObject({ title: "秋", projects: ["Cc", "Ar", "At"], channels: ["discord"], guidance: "g", reward_override: { s2: 700_000 } });
    expect(toEventInput({
      title: "x", starts, ends: starts, projects: "Cc", channels: ["session"], guidance: "", override: { s1: "", s2: "", s3: "", s4: "" },
    }).reward_override).toBeNull();
  });

  it("lists events, creates one through the admin API and shows the refusal reason", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let refuse = true;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, options?: RequestInit) => {
      calls.push({ url: String(input), method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : null });
      if (refuse) return new Response(JSON.stringify({ error: "unknown_project" }), { status: 400 });
      return new Response(JSON.stringify({ event: openEvent }), { status: 201 });
    }));
    const onChanged = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<BountyEvents events={[openEvent]} onChanged={onChanged} />); });
    expect(container.textContent).toContain("秋のバグ探し");
    expect(container.textContent).toContain("開催中");
    expect(container.textContent).toContain("s2: 700000");

    const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
    await act(async () => { button("企画を作る").click(); });
    const inputs = [...container.querySelectorAll('[aria-label="企画の編集"] input')] as HTMLInputElement[];
    await type(inputs[0]!, "冬のバグ探し");
    await type(inputs[1]!, "2026-12-01T10:00");
    await type(inputs[2]!, "2026-12-08T10:00");
    await type(inputs[3]!, "Zz");
    await act(async () => { button("保存").click(); });
    expect(calls.at(-1)).toMatchObject({
      url: "/v1/admin/bounty/events", method: "POST",
      body: { title: "冬のバグ探し", projects: ["Zz"], channels: ["discord", "session"], reward_override: null },
    });
    expect(container.textContent).toContain("登録されていないプロジェクトコードがあります。");
    expect(onChanged).not.toHaveBeenCalled();

    refuse = false;
    await act(async () => { button("早期終了").click(); });
    expect(calls.at(-1)).toMatchObject({ url: "/v1/admin/bounty/events/be_a/end", method: "POST" });
    expect(onChanged).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
  });
});
