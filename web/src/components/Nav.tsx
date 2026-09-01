import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

export type NavSection = "チーム" | "レビュー・PR" | "運用" | "設定";

export interface NavItem {
  to: string;
  label: string;
  section: NavSection;
}

const COLLAPSED_KEY = "concordia.sidebar.collapsed.v1";
const SECTIONS: readonly NavSection[] = ["チーム", "レビュー・PR", "運用", "設定"];

/** @implements spec/feature/teams.md §4.2 sidebar navigation */
export function Nav({ items }: { items: readonly NavItem[] }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setMobileOpen(false);
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobileOpen]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      localStorage.setItem(COLLAPSED_KEY, value ? "0" : "1");
      return !value;
    });
  };

  const renderLinks = (isCollapsed: boolean) => (
    <>
      {SECTIONS.map((section) => (
        <section key={section} className="mb-5">
          {!isCollapsed && <h2 className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{section}</h2>}
          <ul className="space-y-0.5">
            {items.filter((item) => item.section === section).map((item) => {
              const active = location.pathname === item.to;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    title={isCollapsed ? item.label : undefined}
                    className={`block rounded px-3 py-2 text-sm ${active ? "bg-muted text-accent" : "text-subtle hover:bg-muted hover:text-text"}`}
                  >
                    {isCollapsed ? item.label.slice(0, 1) : item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );

  return (
    <>
      <button
        type="button"
        className="md:hidden rounded border border-border px-2 py-1 text-subtle"
        aria-label="メニューを開く"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(true)}
      >
        ☰
      </button>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="presentation">
          <button className="absolute inset-0 bg-black/50" aria-label="メニューを閉じる" onClick={() => setMobileOpen(false)} />
          <nav className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-border bg-surface p-3 shadow-xl" aria-label="メインメニュー">
            <div className="mb-5 flex items-center justify-between">
              <span className="font-semibold"><span className="text-accent">●</span> Concordia</span>
              <button type="button" className="px-2 text-xl text-subtle" aria-label="メニューを閉じる" onClick={() => setMobileOpen(false)}>×</button>
            </div>
            {renderLinks(false)}
          </nav>
        </div>
      )}
      <nav
        aria-label="メインメニュー"
        className={`hidden md:flex shrink-0 flex-col border-r border-border bg-surface p-3 transition-[width] ${collapsed ? "w-16" : "w-56"}`}
      >
        <button type="button" className="mb-4 self-end rounded px-2 py-1 text-subtle hover:bg-muted" aria-label={collapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"} onClick={toggleCollapsed}>
          {collapsed ? "›" : "‹"}
        </button>
        {renderLinks(collapsed)}
      </nav>
    </>
  );
}
