/**
 * レスポンシブなトップナビ。
 *
 * PC (>760px) は全タブを横並び (はみ出しは flex-wrap で折り返す)。
 * モバイル (<=760px) は「使用頻度 top4 + ⋯More」方式 (Memoria と同型):
 *   - usage は localStorage に貯め、 タブクリックで +1。
 *   - default priority (NAV 順) を 1 click 未満のスコアで足し、 履歴ゼロでも
 *     妥当な初期並びにする (1 度でも触れば実 usage が勝つ)。
 *   - active タブは必ず strip に出す (圏外なら 4 番目と入れ替え)。
 *   - More から選んだタブは promote (max+1) して次回 strip の先頭に来る。
 *   - 活性タブが 4 個以下なら全部出して More を出さない。
 *
 * この仕組みは Corpus の宣言的レンダリングにも横展開予定 (Corpus UI feature)。
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

export interface NavItem {
  to: string;
  label: string;
}

const TAB_USAGE_KEY = "concordia.tabUsage.v1";
const TABS_VISIBLE_ON_MOBILE = 4;
const NARROW_MAX_WIDTH = 760;

function readTabUsage(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(TAB_USAGE_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeTabUsage(u: Record<string, number>): void {
  try {
    localStorage.setItem(TAB_USAGE_KEY, JSON.stringify(u));
  } catch {
    /* localStorage 無効環境では諦める */
  }
}

function bumpTabUsage(to: string): void {
  const u = readTabUsage();
  u[to] = (u[to] ?? 0) + 1;
  writeTabUsage(u);
}

/// More から選んだタブを strip の先頭へ promote (= 現状 max + 1 を割当てる)。
function promoteTabToTop(to: string): void {
  const u = readTabUsage();
  let max = 0;
  for (const v of Object.values(u)) if (typeof v === "number" && v > max) max = v;
  u[to] = max + 1;
  writeTabUsage(u);
}

/// usage を反映したスコア順 (降順) に並べた NAV を返す。
/// default priority は NAV の並びに従い、 1 click 未満 (0.001〜) なので
/// 実クリックが必ず勝つ。
function orderByUsage(items: readonly NavItem[]): NavItem[] {
  const u = readTabUsage();
  const score = (it: NavItem) => {
    const idx = items.findIndex((n) => n.to === it.to);
    const def = idx < 0 ? 0 : (items.length - idx) / 1000;
    return (u[it.to] ?? 0) + def;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}

function useNarrow(maxWidth = NARROW_MAX_WIDTH): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setNarrow(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return narrow;
}

export function Nav({ items }: { items: readonly NavItem[] }) {
  const loc = useLocation();
  const narrow = useNarrow();
  const [moreOpen, setMoreOpen] = useState(false);
  // クリックで usage が変わったら再計算させるための tick (localStorage は
  // React state ではないので明示的に再レンダリングを促す)。
  const [, setTick] = useState(0);
  const moreRef = useRef<HTMLDivElement>(null);

  const active = items.some((n) => n.to === loc.pathname) ? loc.pathname : null;

  // strip に出す集合と More に回す集合を決める。
  const useFourRule = narrow && items.length >= TABS_VISIBLE_ON_MOBILE + 1;
  let stripItems: NavItem[];
  let overflowItems: NavItem[];
  if (useFourRule) {
    const ordered = orderByUsage(items);
    const visible = new Set(ordered.slice(0, TABS_VISIBLE_ON_MOBILE).map((t) => t.to));
    if (active && !visible.has(active)) {
      // active が圏外なら strip の最下位 (= 4 番目) を抜いて active を入れる。
      const last = ordered[TABS_VISIBLE_ON_MOBILE - 1];
      if (last) visible.delete(last.to);
      visible.add(active);
    }
    // strip は NAV の並びを保つ (毎クリックで順序が動くと押しにくいため)。
    stripItems = items.filter((n) => visible.has(n.to));
    overflowItems = items.filter((n) => !visible.has(n.to));
  } else {
    stripItems = [...items];
    overflowItems = [];
  }

  // More メニュー外クリック / Esc で閉じる。
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  // narrow から PC に戻ったら More を閉じる。
  useEffect(() => {
    if (!narrow) setMoreOpen(false);
  }, [narrow]);

  const linkClass = (isActive: boolean) =>
    isActive ? "text-accent" : "text-subtle hover:text-text";

  return (
    <nav className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {stripItems.map((n) => (
        <Link
          key={n.to}
          to={n.to}
          onClick={() => {
            bumpTabUsage(n.to);
            setTick((t) => t + 1);
          }}
          className={linkClass(loc.pathname === n.to)}
        >
          {n.label}
        </Link>
      ))}

      {overflowItems.length > 0 && (
        <div className="relative" ref={moreRef}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            className={
              "px-1 " +
              (overflowItems.some((n) => n.to === loc.pathname)
                ? "text-accent"
                : "text-subtle hover:text-text")
            }
            title="その他のタブ"
          >
            ⋯
          </button>
          {moreOpen && (
            <ul
              role="menu"
              className="absolute right-0 top-full mt-1 z-20 min-w-[10rem] rounded border border-border bg-surface py-1 shadow-lg"
            >
              {overflowItems.map((n) => (
                <li key={n.to} role="none">
                  <Link
                    role="menuitem"
                    to={n.to}
                    onClick={() => {
                      // More から選んだタブは次回 strip の先頭に来るよう promote。
                      promoteTabToTop(n.to);
                      setMoreOpen(false);
                      setTick((t) => t + 1);
                    }}
                    className={
                      "block px-3 py-1.5 text-sm " +
                      (loc.pathname === n.to
                        ? "text-accent"
                        : "text-subtle hover:text-text hover:bg-muted")
                    }
                  >
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </nav>
  );
}
