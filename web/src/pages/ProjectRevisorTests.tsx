import { useEffect, useState } from "react";
import { api, RevisorTestsError, type RevisorTestCase } from "../api.js";

// @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01)
//
// Revisor の登録テスト (審査で回すコマンド) をプロジェクトごとに 1 件ずつ足し引きする。
// 一覧は開いたときに Revisor から読み直し、変更のたびに応答の一覧で置き換える。

const ERROR_MESSAGE: Record<string, string> = {
  project_code_not_found: "プロジェクトコードが見つかりません",
  revisor_unreachable: "Revisor に接続できません",
  revisor_unavailable: "Revisor が設定されていません",
  revisor_not_registered: "Revisor にリポジトリ登録がありません",
  revisor_test_case_exists: "同じ名前の登録テストがあります",
  revisor_test_case_limit: "登録テストは 32 件までです",
  revisor_test_case_not_found: "その登録テストはもうありません (一覧を読み直してください)",
  revisor_test_case_last: "最後の 1 件は削除できません (Revisor は登録テスト 0 件を受け付けません)",
  revisor_test_cases_update_failed: "Revisor が更新を受け付けませんでした (コマンドや引数の文字を確認してください)",
  invalid_revisor_test_case: "入力が正しくありません (使えない文字: \" & | < > ^ % !)",
};

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
function describeError(error: unknown): string {
  if (error instanceof RevisorTestsError) return ERROR_MESSAGE[error.code] ?? `失敗しました (${error.message})`;
  return `失敗しました (${String(error)})`;
}

/**
 * 引数は空白区切り。 引用符はシェルを通さない Revisor では意味を持たないので受け付けない。
 * @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01)
 */
function splitArgs(value: string): string[] {
  return value.trim() === "" ? [] : value.trim().split(/\s+/);
}

/** @implements spec/feature/project-code-registry.md — 登録テストの一覧と追加・削除 */
export function RevisorTestsPanel({ code, onClose }: { code: string; onClose: () => void }) {
  const [testCases, setTestCases] = useState<RevisorTestCase[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", command: "", args: "", cwd: ".", timeoutMin: "10" });

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
  useEffect(() => {
    let alive = true;
    api.projectRevisorTests(code)
      .then((result) => { if (alive) setTestCases(result.test_cases); })
      .catch((error: unknown) => { if (alive) setMessage(describeError(error)); });
    return () => { alive = false; };
  }, [code]);

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
  async function run(action: () => Promise<{ test_cases: RevisorTestCase[] }>): Promise<boolean> {
    setBusy(true);
    setMessage("");
    try {
      setTestCases((await action()).test_cases);
      return true;
    } catch (error) {
      setMessage(describeError(error));
      return false;
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

/** @implements spec/feature/project-code-registry.md — 登録テストの追加・削除 (CC-PCR-RVTEST-01) */
  async function add() {
    const ok = await run(() => api.projectRevisorTestAdd(code, {
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: splitArgs(draft.args),
      cwd: draft.cwd.trim() || ".",
      timeout_ms: Math.round(Number(draft.timeoutMin) * 60_000),
    }));
    if (ok) setDraft({ name: "", command: "", args: "", cwd: ".", timeoutMin: "10" });
  }

  const canAdd = !busy && testCases !== null && draft.name.trim() !== "" && draft.command.trim() !== ""
    && Number(draft.timeoutMin) >= 1 && Number(draft.timeoutMin) <= 60;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium">Revisor 登録テスト ({code})</div>
        <button type="button" onClick={onClose} className="text-subtle hover:text-text text-xs">閉じる</button>
      </div>
      {message && <div className="text-[11px] text-danger">{message}</div>}
      {testCases === null ? (
        !message && <div className="text-[11px] text-subtle">読み込み中…</div>
      ) : (
        <table className="w-full text-[11px]">
          <thead className="text-subtle text-left">
            <tr>
              <th className="pr-2 font-normal">名前</th>
              <th className="pr-2 font-normal">コマンド</th>
              <th className="pr-2 font-normal">cwd</th>
              <th className="pr-2 font-normal">上限</th>
              <th className="pr-2 font-normal">対象</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {testCases.map((testCase) => (
              <tr key={testCase.name} className="border-t border-border/50">
                <td className="pr-2 py-0.5 font-mono">{testCase.name}</td>
                <td className="pr-2 py-0.5 font-mono break-all">{[testCase.command, ...testCase.args].join(" ")}</td>
                <td className="pr-2 py-0.5 font-mono">{testCase.cwd}</td>
                <td className="pr-2 py-0.5">{Math.round(testCase.timeout_ms / 60_000)} 分</td>
                <td className="pr-2 py-0.5">
                  {testCase.always ? "常に" : (testCase.kinds?.join(", ") ?? "既定")}
                  {testCase.runtime ? " / 実行時" : ""}
                </td>
                <td className="py-0.5 text-right whitespace-nowrap">
                  {confirming === testCase.name ? (
                    <>
                      <button type="button" disabled={busy}
                        onClick={() => { void run(() => api.projectRevisorTestRemove(code, testCase.name)); }}
                        className="text-danger mr-1 disabled:opacity-40">本当に削除</button>
                      <button type="button" disabled={busy} onClick={() => setConfirming(null)}
                        className="text-subtle hover:text-text disabled:opacity-40">やめる</button>
                    </>
                  ) : (
                    <button type="button" disabled={busy || testCases.length <= 1}
                      title={testCases.length <= 1 ? "最後の 1 件は削除できません" : undefined}
                      onClick={() => setConfirming(testCase.name)}
                      className="text-subtle hover:text-danger disabled:opacity-40">削除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => { event.preventDefault(); if (canAdd) void add(); }}
      >
        <label className="text-[11px] text-subtle">名前
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="foundation-form text-xs block w-32" placeholder="cpp-unit" />
        </label>
        <label className="text-[11px] text-subtle">コマンド
          <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            className="foundation-form text-xs block w-28" placeholder="ctest" />
        </label>
        <label className="text-[11px] text-subtle">引数 (空白区切り)
          <input value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })}
            className="foundation-form text-xs block w-64" placeholder="--test-dir build -C Debug" />
        </label>
        <label className="text-[11px] text-subtle">cwd
          <input value={draft.cwd} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
            className="foundation-form text-xs block w-20" />
        </label>
        <label className="text-[11px] text-subtle">上限 (分)
          <input type="number" min={1} max={60} value={draft.timeoutMin}
            onChange={(e) => setDraft({ ...draft, timeoutMin: e.target.value })}
            className="foundation-form text-xs block w-16" />
        </label>
        <button type="submit" disabled={!canAdd}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-40">追加</button>
      </form>
      <p className="text-[10px] text-subtle">
        審査ごとにリポジトリの複製で実行されます。シェルは通らないので、パイプやリダイレクトは使えません。
      </p>
    </div>
  );
}
