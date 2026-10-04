// @implements SPEC-PBUDGET-VIEW
// @implements SPEC-PBUDGET-ADJUST
import { useEffect, useState } from "react";

import {
  api,
  type PersonalBudgetLedgerEntry,
  type PersonalBudgetPerson,
  type SubsidiarySummary,
} from "../api.js";

// 個人の AI 予算 (spec/feature/personal-ai-budget.md §7)。 子会社の個人ごとの月間分と報酬分、台帳、
// 月間分の上限の設定、本社の調整。 一覧はページングし、台帳は個人を開いたときにだけ取る。
// 残高と履歴は本人と本社の権限者にだけ見せるもので、この画面は本社の管理 UI 専用。

const ALL = "";
const PAGE_SIZE = 50;
const LEDGER_PAGE_SIZE = 20;

const fmt = (tokens: number): string => Math.trunc(tokens).toLocaleString("en-US");

const KIND_LABEL: Record<string, string> = { bounty: "バグ報告", tabula: "Tabula 公開", manual: "本社の調整" };
const TYPE_LABEL: Record<PersonalBudgetLedgerEntry["entry_type"], string> = {
  grant: "報奨", debit: "消費", revoke: "取り消し", manual: "調整",
};

export function PersonalBudget() {
  const [organization, setOrganization] = useState(ALL);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiarySummary[]>([]);
  const [people, setPeople] = useState<PersonalBudgetPerson[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.subsidiariesList().then((r) => setSubsidiaries(r.subsidiaries)).catch(() => setSubsidiaries([]));
  }, []);

  const refresh = async () => {
    try {
      const page = await api.personalBudgetPeople({ subsidiaryId: organization || null, limit: PAGE_SIZE, offset });
      setPeople(page.people);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, [organization, offset]);

  const companyName = (id: string): string => {
    const company = subsidiaries.find((s) => s.id === id);
    return company ? company.display_name || company.name : id;
  };

  return (
    <div className="space-y-4 max-w-5xl">
      <header>
        <h1 className="text-lg font-semibold">個人の AI 予算</h1>
        <p className="text-subtle text-sm mt-1">
          子会社の個人ごとの月間分 (月初に戻る) と報酬分 (報奨で増える残高)。消費は月間分から先に引き、
          月間分が尽きてから報酬分を引きます。月間分の既定値は子会社の設定で、ここでは個人ごとに上書きできます。
          本社メンバーは対象外です。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">会社</span>
          <select
            className="foundation-form text-sm"
            value={organization}
            onChange={(e) => { setOffset(0); setOrganization(e.target.value); }}
          >
            <option value={ALL}>すべての子会社</option>
            {subsidiaries.filter((s) => s.mode === "subsidiary").map((s) => (
              <option key={s.id} value={s.id}>{s.display_name || s.name}</option>
            ))}
          </select>
        </label>
        <span className="text-xs text-subtle ml-auto">
          {total === 0 ? "0 人" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total} 人`}
        </span>
        <button type="button" className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50"
          disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          前へ
        </button>
        <button type="button" className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50"
          disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
          次へ
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}
      {people.length === 0 && !error && (
        <div className="text-subtle text-sm">
          個人の記録はまだありません。子会社で依頼が出るか、報奨・調整が付くとここに並びます。
        </div>
      )}
      {people.map((person) => (
        <PersonRow key={person.id} person={person} companyName={companyName(person.subsidiary_id)} onChanged={() => void refresh()} />
      ))}
    </div>
  );
}

function PersonRow({ person, companyName, onChanged }: {
  person: PersonalBudgetPerson;
  companyName: string;
  onChanged: () => void;
}) {
  const [limitText, setLimitText] = useState(person.monthly_token_limit_override === null ? "" : String(person.monthly_token_limit_override));
  const [tokensText, setTokensText] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const saveLimit = async () => {
    const trimmed = limitText.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      setMessage({ ok: false, text: "月間分の上限は 0 以上の整数で入力してください (空欄で子会社の既定値)。" });
      return;
    }
    try {
      await api.personalBudgetSetMonthlyLimit(person.id, value);
      setMessage({ ok: true, text: "月間分の上限を保存しました" });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  const adjust = async () => {
    const tokens = Number(tokensText.trim());
    if (!Number.isInteger(tokens) || tokens === 0) {
      setMessage({ ok: false, text: "トークン数は 0 以外の整数で入力してください (負で減額)。" });
      return;
    }
    if (!reason.trim()) {
      setMessage({ ok: false, text: "理由を入力してください。理由の無い調整は受け付けません。" });
      return;
    }
    try {
      const result = await api.personalBudgetAdjust({ person_id: person.id, tokens, reason: reason.trim() });
      setTokensText("");
      setReason("");
      setMessage({ ok: true, text: `調整しました (報酬分の残り ${fmt(result.reward_balance)})` });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  const monthly = person.monthly_limit > 0
    ? `${fmt(person.monthly_used)} / ${fmt(person.monthly_limit)} (残り ${fmt(person.monthly_remaining ?? 0)})`
    : `${fmt(person.monthly_used)} / 上限なし`;

  return (
    <section className="border border-border rounded p-3 bg-surface space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
        <span className="text-sm text-text font-medium">{person.display_name || "(表示名なし)"}</span>
        <span>{companyName}</span>
        <span>{person.platform}</span>
        <code>{person.platform_user_id}</code>
      </div>
      <dl className="grid gap-2 md:grid-cols-2">
        <div>
          <dt className="text-[11px] text-subtle">月間分 ({person.period})</dt>
          <dd>{monthly}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-subtle">報酬分の残り</dt>
          <dd>{fmt(person.reward_balance)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">月間分の上限の上書き (空欄 = 子会社の既定値、0 = 上限なし)</span>
          <input className="foundation-form" inputMode="numeric" aria-label="月間分の上限の上書き"
            value={limitText} onChange={(e) => setLimitText(e.target.value)} />
        </label>
        <button type="button" className="px-3 py-1 rounded bg-accent text-white text-xs" onClick={() => void saveLimit()}>
          上限を保存
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">報酬分の調整 (負で減額、残高は 0 まで)</span>
          <input className="foundation-form" inputMode="numeric" aria-label="調整するトークン数" placeholder="例: 300000"
            value={tokensText} onChange={(e) => setTokensText(e.target.value)} />
        </label>
        <label className="space-y-1 flex-1 min-w-[200px]">
          <span className="text-[11px] text-subtle block">理由 (必須。台帳に残り、本人へ通知します)</span>
          <input className="foundation-form w-full" aria-label="調整の理由" maxLength={500}
            value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="button" className="px-3 py-1 rounded bg-accent text-white text-xs" onClick={() => void adjust()}>
          調整する
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="text-xs text-accent" onClick={() => setLedgerOpen(!ledgerOpen)}>
          {ledgerOpen ? "台帳を閉じる" : "台帳を見る"}
        </button>
        {message && <span className={`text-xs ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</span>}
      </div>
      {ledgerOpen && <Ledger personId={person.id} revision={person.reward_balance} />}
    </section>
  );
}

/** 個人単位の台帳。 開いたときにだけ取り、ページングする。 */
function Ledger({ personId, revision }: { personId: string; revision: number }) {
  const [entries, setEntries] = useState<PersonalBudgetLedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.personalBudgetLedger(personId, { limit: LEDGER_PAGE_SIZE, offset })
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setTotal(page.total);
        setError(null);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [personId, offset, revision]);

  if (error) return <div className="text-danger text-xs">{error}</div>;
  if (entries.length === 0) return <div className="text-subtle text-xs">台帳の記録はまだありません。</div>;
  return (
    <div className="space-y-1">
      <table className="w-full text-xs">
        <thead className="text-subtle text-left">
          <tr><th className="pr-2">日時</th><th className="pr-2">種別</th><th className="pr-2 text-right">トークン</th><th>内容</th></tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-t border-border align-top">
              <td className="pr-2 whitespace-nowrap">{new Date(entry.created_at).toLocaleString("ja-JP")}</td>
              <td className="pr-2 whitespace-nowrap">{TYPE_LABEL[entry.entry_type]}</td>
              <td className="pr-2 text-right whitespace-nowrap">{entry.tokens >= 0 ? "+" : "-"}{fmt(Math.abs(entry.tokens))}</td>
              <td>{describe(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > LEDGER_PAGE_SIZE && (
        <div className="flex items-center gap-2 text-xs text-subtle">
          <span>{offset + 1}–{Math.min(offset + LEDGER_PAGE_SIZE, total)} / {total} 件</span>
          <button type="button" className="disabled:opacity-50" disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LEDGER_PAGE_SIZE))}>前へ</button>
          <button type="button" className="disabled:opacity-50" disabled={offset + LEDGER_PAGE_SIZE >= total}
            onClick={() => setOffset(offset + LEDGER_PAGE_SIZE)}>次へ</button>
        </div>
      )}
    </div>
  );
}

function describe(entry: PersonalBudgetLedgerEntry): string {
  if (entry.entry_type === "debit") return `セッションの消費 (${entry.period ?? "-"})`;
  const kind = KIND_LABEL[entry.reward_kind ?? ""] ?? "";
  const parts = [kind, entry.reason ?? "", entry.actor ? `操作: ${entry.actor}` : "", entry.source_ref && entry.entry_type !== "manual" ? `根拠: ${entry.source_ref}` : ""];
  return parts.filter(Boolean).join(" / ");
}
