// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatMarkdown } from "./ChatMarkdown.js";

afterEach(cleanup);

describe("chat Markdown rendering", () => {
  it("renders GFM tables in a keyboard-accessible scrolling region, with headings and lists", () => {
    render(<ChatMarkdown content={"## 結果\n\n| 項目 | 状態 |\n| --- | --- |\n| A | **完了** |\n\n- 確認済み"} />);
    expect(screen.getByRole("heading", { name: "結果" })).toBeTruthy();
    expect(screen.getByRole("table").closest('[role="region"]')?.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("columnheader", { name: "項目" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "完了" }).querySelector("strong")).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toBe("確認済み");
  });

  it("preserves code indentation and keeps raw HTML and unsafe links inert", () => {
    const view = render(<ChatMarkdown content={'```ts\n  const answer = "<tag>";\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.com)'} />);
    expect(view.container.querySelector("pre code")?.textContent).toBe('  const answer = "<tag>";\n');
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByText("unsafe").getAttribute("href")).not.toMatch(/^javascript:/i);
    expect(screen.getByRole("link", { name: "safe" }).getAttribute("rel")).toContain("noopener");
  });
});
