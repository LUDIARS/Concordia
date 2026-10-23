import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteParttimers } from "./SiteParttimers.js";

const state = (exception: boolean | null) => ({
  site: "melpot", default_active: false, default_configured: false,
  templates: [{ id: "t1", call_name: "mail-watch", title: "メール監視", template_active: true, exception, effective_active: exception === true }],
});
let fetcher: ReturnType<typeof vi.fn>;
let exception: boolean | null = null;
beforeEach(() => {
  exception = null;
  fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/v1/federation/site") return Response.json({ siteId: "melpot" });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { enabled?: boolean | null };
      if ("enabled" in body) exception = body.enabled ?? null;
      return Response.json({ ok: true });
    }
    return Response.json(state(exception));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("拠点のパートタイマー (SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS)", () => {
  it("この Concordia の拠点の既定と一覧を出す", async () => {
    render(<SiteParttimers />);
    expect(await screen.findByText("メール監視")).toBeInTheDocument();
    expect(screen.getByLabelText("拠点 ID")).toHaveValue("melpot");
    expect(screen.getByText("オフ")).toBeInTheDocument();
    expect(screen.getByText("動かない")).toBeInTheDocument();
  });

  it("気に入ったものだけオンにする", async () => {
    render(<SiteParttimers />);
    await screen.findByText("メール監視");
    fireEvent.change(screen.getByLabelText("mail-watch の個別設定"), { target: { value: "on" } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/v1/delegation/site-category-defaults/melpot/parttimer/templates/t1",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
    ));
    expect(await screen.findByText("動く")).toBeInTheDocument();
  });
});
