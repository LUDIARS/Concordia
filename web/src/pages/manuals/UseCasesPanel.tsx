// @implements SPEC-DLG-USE-CASES
import { useEffect, useState } from "react";

import {
  api,
  type SubsidiarySummary,
  type UseCase,
  type UseCaseFormat,
  type UseCaseFormatKey,
} from "../../api.js";
import { UseCasesCorrections } from "./UseCasesCorrections.js";

// ユースケースのタブ (spec/feature/dialogue-context.md)。 部署のセッションが何をするかを
// フォーマット (雛形) から作り、概要・作業モード・事前データ・依頼者メモの使用を編集する。
// 部署がどのユースケースを使うかは部署管理ページで選ぶ。

export function UseCasesPanel() {
  const [formats, setFormats] = useState<UseCaseFormat[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiarySummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newFormat, setNewFormat] = useState<UseCaseFormatKey>("qa");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setUseCases((await api.useCasesList(true)).use_cases);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    api.useCaseFormats().then((r) => setFormats(r.formats)).catch(() => setFormats([]));
    api.subsidiariesList().then((r) => setSubsidiaries(r.subsidiaries)).catch(() => setSubsidiaries([]));
    void refresh();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const selectedFormat = formats.find((format) => format.key === newFormat);

  return (
    <div className="space-y-3">
      <p className="text-subtle text-sm">
        部署のセッションが「何をするか」を定義します。フォーマットは作成時の初期値だけを与え、作成後はここで調整します。
        読み取り専用のユースケースを持つ部署のセッションは、ファイル編集と git の書き込みがハーネスで止まります。
      </p>
      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="border border-border rounded p-3 bg-surface space-y-2">
        <div className="text-sm font-semibold">フォーマットから作成</div>
        <div className="flex flex-wrap gap-2">
          <select className="foundation-form text-sm" value={newFormat} onChange={(e) => setNewFormat(e.target.value as UseCaseFormatKey)}>
            {formats.map((format) => <option key={format.key} value={format.key}>{format.name}</option>)}
          </select>
          <input className="foundation-form text-sm" placeholder="名前 (例: 技術相談)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input className="foundation-form text-sm" placeholder="slug (例: tech-qa)" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} />
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-accent text-white text-sm disabled:opacity-50"
            disabled={!newName.trim() || !newSlug.trim()}
            onClick={() => void run(async () => {
              const r = await api.useCaseCreate({ name: newName.trim(), slug: newSlug.trim(), format: newFormat });
              setNewName("");
              setNewSlug("");
              setOpenId(r.use_case.id);
            })}
          >
            作成
          </button>
        </div>
        {selectedFormat && (
          <div className="text-xs text-subtle">
            {selectedFormat.summary} (作業モード: {selectedFormat.workMode === "read-only" ? "読み取り専用" : "編集可"} /
            依頼者メモ: {selectedFormat.useRequesterProfile ? "使う" : "使わない"} /
            事前ヒアリング: {selectedFormat.intake ? "する" : "しない"})
          </div>
        )}
      </div>

      {useCases.map((useCase) => (
        <section key={useCase.id} className="border border-border rounded bg-surface">
          <div className="flex items-center gap-2 px-3 py-2">
            <button type="button" className="font-medium text-left" onClick={() => setOpenId(openId === useCase.id ? null : useCase.id)}>
              {useCase.name}
            </button>
            <span className="text-xs text-subtle">{useCase.format_name}</span>
            <span className="text-xs text-subtle">{useCase.work_mode === "read-only" ? "読み取り専用" : "編集可"}</span>
            {useCase.intake_enabled && <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-subtle">事前ヒアリング</span>}
            {useCase.archived && <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-subtle">廃止</span>}
            <button type="button" className="ml-auto text-xs text-accent"
              onClick={() => void run(() => (useCase.archived ? api.useCaseRestore(useCase.id) : api.useCaseArchive(useCase.id)))}>
              {useCase.archived ? "復帰" : "廃止"}
            </button>
            <button type="button" className="text-xs text-danger" onClick={() => void run(() => api.useCaseDelete(useCase.id))}>
              削除
            </button>
          </div>
          {openId === useCase.id && (
            <div className="border-t border-border px-3 py-3 space-y-4">
              <UseCaseEditor useCase={useCase} onSaved={() => void refresh()} />
              <UseCasesCorrections useCaseId={useCase.id} subsidiaries={subsidiaries} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function UseCaseEditor({ useCase, onSaved }: { useCase: UseCase; onSaved: () => void }) {
  const [name, setName] = useState(useCase.name);
  const [summary, setSummary] = useState(useCase.summary);
  const [workMode, setWorkMode] = useState(useCase.work_mode);
  const [preData, setPreData] = useState(useCase.pre_data);
  const [useProfile, setUseProfile] = useState(useCase.use_requester_profile);
  const [intake, setIntake] = useState(useCase.intake_enabled);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    try {
      await api.useCaseUpdate(useCase.id, {
        name: name.trim(), summary, work_mode: workMode, pre_data: preData, use_requester_profile: useProfile,
        intake_enabled: intake,
      });
      setMessage({ ok: true, text: "保存しました" });
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="grid gap-2 md:grid-cols-2">
        <input className="foundation-form" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="foundation-form" value={workMode} onChange={(e) => setWorkMode(e.target.value as UseCase["work_mode"])}>
          <option value="edit">編集可</option>
          <option value="read-only">読み取り専用</option>
        </select>
      </div>
      <input className="foundation-form w-full" placeholder="概要 (何をするか)" value={summary} onChange={(e) => setSummary(e.target.value)} />
      <textarea className="foundation-form w-full min-h-[120px] font-mono text-xs" placeholder="事前データ (回答方針・参照資料・形式)"
        value={preData} onChange={(e) => setPreData(e.target.value)} />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={useProfile} onChange={(e) => setUseProfile(e.target.checked)} />
        依頼者メモ (技術者レベル・やっていること) を起動時に渡す
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={intake} onChange={(e) => setIntake(e.target.checked)} />
        回答の前に事前ヒアリング (知りたいこと・技術レベル・役職・目的) を揃える
      </label>
      <div className="flex items-center gap-3">
        <button type="button" className="px-3 py-1.5 rounded bg-accent text-white text-sm" onClick={() => void save()}>保存</button>
        {message && <span className={`text-xs ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</span>}
      </div>
    </div>
  );
}
