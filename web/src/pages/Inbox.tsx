import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api, type InboxItem, type InboxResult } from "../api.js";
import { clientId } from "../lib/client-id.js";
import { answerLink, elapsedLabel, elapsedStyle, visibleItems } from "./inbox/view-model.js";

// 承認インボックス — 人間宛ての未回答事項を 1 画面にまとめる。
//
// ask カード / inquiry の ask_human / Director の blocked / confirm の承認待ちは、
// それぞれ別の面に溜まる。 **「いま自分が答えるべきものは何件か」を見る場所が無く**、
// Discord を遡るか各画面を回るしかなかった。
//
// ここは読み取り面。 **回答・解決はしない** — 各項目から既存の回答経路へ飛ぶだけで、
// この画面が正本の状態を書き換えることはない。 既読・スヌーズだけは別で、
// ブラウザごとの UI 状態として持つ (誰が答えたかではなく、 自分がもう見たか)。
//
// @implements spec/feature/approval-inbox.md §2

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  "ask-card": "質問カード",
  "inquiry-ask-human": "判断待ち",
  "director-blocked": "工程が blocked",
  "confirm-pending": "承認待ち",
};

const KIND_STYLE: Record<InboxItem["kind"], string> = {
  "ask-card": "bg-accent/20 text-accent",
  "inquiry-ask-human": "bg-warn/20 text-warn",
  "director-blocked": "bg-warn/20 text-warn",
  "confirm-pending": "bg-subtle/20 text-subtle",
};

/** スヌーズの選択肢。 「あとで」の粒度は、 その日のうちか翌日かで足りる。 */
const SNOOZE_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "1時間", hours: 1 },
  { label: "4時間", hours: 4 },
  { label: "明日", hours: 24 },
];

const HOUR_MS = 3_600_000;

function InboxRow({
  item,
  busy,
  onRead,
  onSnooze,
}: {
  item: InboxItem;
  busy: boolean;
  onRead: (item: InboxItem, read: boolean) => void;
  onSnooze: (item: InboxItem, until: number | null) => void;
}) {
  const link = answerLink(item);
  return (
    <li
      className={`border border-border rounded px-3 py-2 flex flex-col gap-1 ${
        item.snoozed ? "opacity-50" : ""
      } ${item.read_at !== null ? "bg-transparent" : "bg-surface"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded ${KIND_STYLE[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
        <span className={elapsedStyle(item.elapsed_ms)}>{elapsedLabel(item.elapsed_ms)}経過</span>
        {item.read_at !== null ? <span className="text-subtle">既読</span> : null}
        {item.snoozed ? <span className="text-subtle">スヌーズ中</span> : null}
        {item.repo_origin ? (
          <span className="text-subtle">
            {item.repo_origin}
            {item.pr_number !== null ? `#${item.pr_number}` : ""}
          </span>
        ) : null}
      </div>
      <div className="text-sm break-words">{item.summary}</div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {link ? (
          <Link className="text-accent hover:underline" to={link.to}>
            {link.label}
          </Link>
        ) : (
          <span className="text-subtle">WebUI の回答経路なし</span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-subtle hover:text-fg disabled:opacity-50"
            disabled={busy}
            onClick={() => onRead(item, item.read_at === null)}
          >
            {item.read_at !== null ? "未読に戻す" : "既読にする"}
          </button>
          {item.snoozed ? (
            <button
              type="button"
              className="text-subtle hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={() => onSnooze(item, null)}
            >
              スヌーズ解除
            </button>
          ) : (
            SNOOZE_OPTIONS.map((option) => (
              <button
                key={option.hours}
                type="button"
                className="text-subtle hover:text-fg disabled:opacity-50"
                disabled={busy}
                onClick={() => onSnooze(item, Date.now() + option.hours * HOUR_MS)}
              >
                {option.label}
              </button>
            ))
          )}
        </span>
      </div>
    </li>
  );
}

export function Inbox() {
  const [result, setResult] = useState<InboxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const browserId = useMemo(clientId, []);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await api.inbox(browserId);
      if (request !== requestRef.current) return;
      setResult(next);
      setError(null);
    } catch (e) {
      if (request !== requestRef.current) return;
      setError((e as Error).message);
    }
  }, [browserId]);

  useEffect(() => {
    void load();
    // 回答は別の面で行われるので、 この画面は自分では変化を知れない。 定期的に読み直す。
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => {
      clearInterval(timer);
      requestRef.current += 1;
    };
  }, [load]);

  const mutate = useCallback(async (item: InboxItem, run: () => Promise<unknown>) => {
    setBusyKey(item.key);
    try {
      await run();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  const onRead = useCallback((item: InboxItem, read: boolean) => {
    void mutate(item, () => api.inboxMarkRead(browserId, item.key, read));
  }, [browserId, mutate]);

  const onSnooze = useCallback((item: InboxItem, until: number | null) => {
    void mutate(item, () => api.inboxSnooze(browserId, item.key, until));
  }, [browserId, mutate]);

  const items = visibleItems(result?.items ?? [], showSnoozed);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">未回答</h1>
        {result ? (
          <span className="text-sm text-subtle">
            {result.active_count} 件
            {result.count !== result.active_count ? ` (スヌーズ中 ${result.count - result.active_count} 件を含めて ${result.count} 件)` : ""}
          </span>
        ) : null}
        <label className="ml-auto text-xs text-subtle flex items-center gap-1">
          <input
            type="checkbox"
            checked={showSnoozed}
            onChange={(event) => setShowSnoozed(event.target.checked)}
          />
          スヌーズ中も表示
        </label>
      </div>

      <p className="text-xs text-subtle">
        古い順に並びます。 回答はそれぞれの面で行い、 この画面は状態を書き換えません。
        既読とスヌーズはこのブラウザだけの表示設定です。
      </p>

      {error ? <div className="text-sm text-warn">読み込みに失敗しました: {error}</div> : null}

      {result === null ? (
        error === null ? <div className="text-sm text-subtle">読み込み中…</div> : null
      ) : items.length === 0 ? (
        <div className="text-sm text-subtle">
          {result.count === 0 ? "未回答はありません。" : "表示できる項目がありません (すべてスヌーズ中)。"}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <InboxRow
              key={item.key}
              item={item}
              busy={busyKey === item.key}
              onRead={onRead}
              onSnooze={onSnooze}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
