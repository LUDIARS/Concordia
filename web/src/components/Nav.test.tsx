// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Nav, type NavItem } from "./Nav.js";

const ITEMS: NavItem[] = [
  { to: "/", label: "Monitor", section: "チーム" },
  { to: "/work", label: "Work", section: "チーム" },
  { to: "/settings", label: "設定", section: "設定" },
];

function renderNav(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="*" element={<Nav items={ITEMS} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Nav デスクトップ", () => {
  it("サイドバーが常駐し、全リンクがラベル表示される", () => {
    renderNav();
    const desktopNav = screen.getByRole("navigation", { name: "メインメニュー" });
    expect(within(desktopNav).getByRole("link", { name: "Monitor" })).not.toBeNull();
    expect(within(desktopNav).getByRole("link", { name: "設定" })).not.toBeNull();
  });

  it("collapse 切替でアイコンのみ表示になり、localStorage に永続化される", async () => {
    const user = userEvent.setup();
    renderNav();
    const toggle = screen.getByRole("button", { name: "サイドバーを折りたたむ" });

    await user.click(toggle);

    expect(localStorage.getItem("concordia.sidebar.collapsed.v1")).toBe("1");
    expect(screen.getByRole("button", { name: "サイドバーを展開" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Monitor" })).toBeNull();
    expect(screen.getByRole("link", { name: "M" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "サイドバーを展開" }));

    expect(localStorage.getItem("concordia.sidebar.collapsed.v1")).toBe("0");
    expect(screen.getByRole("link", { name: "Monitor" })).not.toBeNull();
  });

  it("localStorage の永続状態から collapsed で初期表示される", () => {
    localStorage.setItem("concordia.sidebar.collapsed.v1", "1");
    renderNav();
    expect(screen.getByRole("button", { name: "サイドバーを展開" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Monitor" })).toBeNull();
  });
});

describe("Nav モバイル", () => {
  function closeButtons() {
    return screen.getAllByRole("button", { name: "メニューを閉じる" });
  }

  it("hamburger クリックでオーバーレイが開く", async () => {
    const user = userEvent.setup();
    renderNav();

    const hamburger = screen.getByRole("button", { name: "メニューを開く" });
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("button", { name: "メニューを閉じる" })).toHaveLength(0);

    await user.click(hamburger);
    expect(hamburger.getAttribute("aria-expanded")).toBe("true");
    // backdrop ボタンと × ボタンの 2 つが同じ aria-label で存在する
    expect(closeButtons()).toHaveLength(2);
  });

  it("× ボタンクリックで閉じる", async () => {
    const user = userEvent.setup();
    renderNav();

    const hamburger = screen.getByRole("button", { name: "メニューを開く" });
    await user.click(hamburger);
    const [, closeButton] = closeButtons();

    await user.click(closeButton);
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("button", { name: "メニューを閉じる" })).toHaveLength(0);
  });

  it("backdrop クリックで閉じる", async () => {
    const user = userEvent.setup();
    renderNav();

    const hamburger = screen.getByRole("button", { name: "メニューを開く" });
    await user.click(hamburger);
    const [backdrop] = closeButtons();

    await user.click(backdrop);
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("button", { name: "メニューを閉じる" })).toHaveLength(0);
  });

  it("Escape キーでオーバーレイが閉じる", async () => {
    const user = userEvent.setup();
    renderNav();

    await user.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(closeButtons()).toHaveLength(2);

    await user.keyboard("{Escape}");
    expect(screen.queryAllByRole("button", { name: "メニューを閉じる" })).toHaveLength(0);
  });

  it("route 変更でオーバーレイが閉じる", async () => {
    const user = userEvent.setup();
    renderNav();

    await user.click(screen.getByRole("button", { name: "メニューを開く" }));
    const [overlayNav] = screen.getAllByRole("navigation", { name: "メインメニュー" });
    await user.click(within(overlayNav).getByRole("link", { name: "Work" }));

    expect(screen.queryAllByRole("button", { name: "メニューを閉じる" })).toHaveLength(0);
  });
});
