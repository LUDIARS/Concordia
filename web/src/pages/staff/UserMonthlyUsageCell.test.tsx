// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { UserMonthlyUsageCell } from "./UserMonthlyUsageCell.js";

afterEach(() => cleanup());

describe("UserMonthlyUsageCell", () => {
  it("予算の無い人にも今月の消費を出す", () => {
    render(<UserMonthlyUsageCell usage={{ user_id: "111", consumed_tokens: 12_345, team_tokens: 0, budget: null }} />);
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.queryByText(/うちチーム/)).toBeNull();
  });

  it("チーム予算から引いたぶんを内訳で添える", () => {
    render(<UserMonthlyUsageCell usage={{ user_id: "111", consumed_tokens: 3_000, team_tokens: 1_000, budget: null }} />);
    expect(screen.getByText("3,000")).toBeTruthy();
    expect(screen.getByText("うちチーム 1,000")).toBeTruthy();
  });

  it("今月まだ消費の無い人は 0", () => {
    render(<UserMonthlyUsageCell usage={null} />);
    expect(screen.getByText("0")).toBeTruthy();
  });
});
