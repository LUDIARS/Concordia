import { useEffect, useState, useCallback } from "react";
import {
  api,
  fmtTs,
  type HarnessRule,
  type HarnessAuditRow,
  type HarnessAuditDecision,
  type HarnessAuditEvent,
  type SubsidiarySummary,
  type SubsidiaryInput,
  type SubsidiaryDelegation,
  type SubsidiaryLock,
  type SubsidiaryRequest,
  type DelegationTemplateLite,
} from "../../api.js";
import { SubsidiaryProjectSpawnForm } from "../../components/SubsidiaryProjectSpawnForm.js";
import { runMutation } from "../../lib/mutation.js";

// ─── 共通ハーネスルール ──────────────────────────────────────────────

export function HarnessRulesSection() {
  const [rules, setRules] = useState<HarnessRule[]>([]);
  const [draft, setDraft] = useState<{ kind: "allow" | "block"; title: string; description: string }>({
    kind: "block",
    title: "",
    description: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.harnessRulesList(true).then((r) => setRules(r.rules)).catch((e) => setErr(String(e)));
  }, []);
  useEffect(load, [load]);

  const toggle = async (r: HarnessRule) => {
    await runMutation({
      setBusy,
      setError: setErr,
      action: () => api.harnessRuleUpdate(r.id, { enabled: !r.enabled }),
      onSuccess: load,
    });
  };
  const remove = async (r: HarnessRule) => {
    await runMutation({
      confirmMessage: `ルール「${r.title || r.id}」を削除しますか?`,
      setBusy,
      setError: setErr,
      action: async () => {
        const res = await api.harnessRuleDelete(r.id);
        if (!res.ok) throw new Error(res.error === "builtin_cannot_delete" ? "既定ルールは削除できません (無効化のみ可)" : String(res.error));
        return res;
      },
      onSuccess: load,
    });
  };
  const add = async () => {
    if (!draft.description.trim()) return;
    await runMutation({
      setBusy,
      setError: setErr,
      action: () => api.harnessRuleCreate({ kind: draft.kind, title: draft.title, description: draft.description }),
      onSuccess: () => {
        setDraft({ kind: "block", title: "", description: "" });
        load();
      },
    });
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">共通ハーネスルール</h2>
      <p className="text-subtle text-xs mb-3">
        子会社ガード (Sonnet) が全依頼を判定するときに参照するポリシー。 allow=許可方針 / block=遮断方針。
        既定ルールは無効化のみ可 (削除不可)。
      </p>
      {err && <div className="text-red-400 text-xs mb-2">{err}</div>}
      <div className="flex flex-col gap-2 mb-4">
        {rules.map((r) => (
          <div
            key={r.id}
            className={`border border-border rounded-md p-2 flex items-start gap-3 ${r.enabled ? "" : "opacity-50"}`}
          >
            <span
              className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
                r.kind === "allow" ? "bg-green-900 text-green-200" : "bg-red-900 text-red-200"
              }`}
            >
              {r.kind}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {r.title || "(無題)"}
                {r.builtin === true && <span className="ml-2 text-[10px] text-subtle">既定</span>}
              </div>
              <div className="text-xs text-subtle whitespace-pre-wrap break-words">{r.description}</div>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button className="text-xs underline" disabled={busy} onClick={() => toggle(r)}>
                {r.enabled ? "無効化" : "有効化"}
              </button>
              {r.builtin !== true && (
                <button className="text-xs underline text-red-400" disabled={busy} onClick={() => remove(r)}>
                  削除
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="border border-border rounded-md p-3 flex flex-col gap-2">
        <div className="text-xs text-subtle">ルールを追加</div>
        <div className="flex gap-2 items-center">
          <select
            className="foundation-form"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as "allow" | "block" })}
          >
            <option value="block">block (遮断)</option>
            <option value="allow">allow (許可)</option>
          </select>
          <input
            className="foundation-form flex-1"
            placeholder="タイトル"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <textarea
          className="foundation-form"
          rows={2}
          placeholder="ガードに渡す自然文ルール (例: 認証情報を含むファイルに触れる依頼は拒否する)"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <button className="self-start text-sm px-3 py-1 rounded-md bg-accent text-black disabled:opacity-50" disabled={busy} onClick={add}>
          追加
        </button>
      </div>
    </section>
  );
}
