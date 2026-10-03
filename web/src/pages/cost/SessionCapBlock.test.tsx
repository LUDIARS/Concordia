// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SessionCapBlock } from "./SessionCapBlock.js";

describe("SessionCapBlock", () => {

  it("shows running sessions against each company's cap, and marks a company at its cap", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const companies = [
      { subsidiary_id: null, name: "本社", active: 30, max: 30, reached: true },
      { subsidiary_id: "sub-1", name: "出張所", active: 2, max: 0, reached: false },
    ];
    await act(async () => { createRoot(container).render(<SessionCapBlock companies={companies} />); });
    const rows = [...container.querySelectorAll("tr")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("本社");
    expect(rows[0]).toContain("30 / 30");
    expect(rows[0]).toContain("上限");
    expect(rows[1]).toContain("出張所");
    expect(rows[1]).toContain("2 / 上限なし");
    expect(rows[1]).not.toContain("⚠️");
  });

  it("says the counts are unavailable when the API returned no companies", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => { createRoot(container).render(<SessionCapBlock companies={[]} />); });
    expect(container.textContent).toContain("取得できませんでした");
  });
});
