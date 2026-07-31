import { useCallback, useEffect, useState } from "react";

import { api, fmtTs, type HarnessRule } from "../../api.js";
import { runMutation } from "../../lib/mutation.js";

// ハーネスルール (allow / block) の詳細編集パネル。
//
// 旧「子会社」ページの一覧表示から、 マニュアルページ側の編集 UI へ移設したもの。
// 1 件ずつ kind / タイトル / 本文 / 並び順 / 有効無効を直接編集できる。
// 既定ルール (builtin) は本文を上書きできるが削除はできない (無効化のみ)。

interface RuleDraft {
  kind: "allow" | "block";
  title: string;
  description: string;
  sort_order: number;
}

function toDraft(rule: HarnessRule): RuleDraft {
  return {
    kind: rule.kind,
    title: rule.title,
    description: rule.description,
    sort_order: rule.sort_order,
  };
}

/** バックエンド (`ORDER BY sort_order ASC, created_at ASC`) と同じ並び。 */
function sortRules(rules: HarnessRule[]): HarnessRule[] {
  return [...rules].sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
}

function isDirty(rule: HarnessRule, draft: RuleDraft): boolean {
  return draft.kind !== rule.kind
    || draft.title !== rule.title
    || draft.description !== rule.description
    || draft.sort_order !== rule.sort_order;
}

function RuleCard({
  rule,
  busy,
  onSave,
  onToggle,
  onRemove,
}: {
  rule: HarnessRule;
  busy: boolean;
  onSave: (draft: RuleDraft) => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => toDraft(rule));
  // 保存後・他セッション更新後は正本 (rule) に合わせ直す。
  useEffect(() => { setDraft(toDraft(rule)); }, [rule]);

  const dirty = isDirty(rule, draft);
  return (
    <article
      className={
        "border border-border rounded p-3 space-y-2 bg-surface " + (rule.enabled ? "" : "opacity-60")
      }
    >
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={draft.kind}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as "allow" | "block" })}
          className="foundation-form text-sm"
        >
          <option value="block">block (遮断)</option>
          <option value="allow">allow (許可)</option>
        </select>
        <input
          type="text"
          value={draft.title}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="タイトル"
          className="foundation-form text-sm flex-1 min-w-40"
        />
        <label className="flex items-center gap-1 text-[11px] text-subtle">
          並び
          <input
            type="number"
            value={draft.sort_order}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) || 0 })}
            className="foundation-form text-sm w-16"
          />
        </label>
        {rule.builtin && <span className="text-[10px] text-subtle">既定</span>}
        <span
          className={
            "text-[11px] px-1.5 py-0.5 rounded " +
            (rule.enabled ? "bg-ok/20 text-ok" : "bg-subtle/20 text-subtle")
          }
        >
          {rule.enabled ? "有効" : "無効"}
        </span>
      </div>

      <textarea
        value={draft.description}
        disabled={busy}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        placeholder="ガードに渡す自然文ルール (例: 認証情報を含むファイルに触れる依頼は拒否する)"
        className="foundation-form w-full h-20 text-sm"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={busy || !dirty || !draft.description.trim()}
          onClick={() => onSave(draft)}
          className="bg-accent text-bg px-3 py-1 rounded text-sm font-medium disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className="px-3 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-40"
        >
          {rule.enabled ? "無効化" : "有効化"}
        </button>
        {!rule.builtin && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="text-subtle hover:text-danger text-xs disabled:opacity-40"
          >
            削除
          </button>
        )}
        {dirty && <span className="text-subtle text-[11px]">未保存の変更があります</span>}
        <span className="ml-auto text-subtle text-[11px]">更新: {fmtTs(rule.updated_at)}</span>
      </div>
    </article>
  );
}

export function HarnessRulesPanel() {
  const [rules, setRules] = useState<HarnessRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState<RuleDraft>({
    kind: "block",
    title: "",
    description: "",
    sort_order: 0,
  });

  const load = useCallback(() => {
    api.harnessRulesList(true).then((r) => setRules(r.rules)).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  // GET /v1/harness-rules は HTTP キャッシュ (5s) に乗るので、 保存直後に再取得すると
  // 更新前の本文が返って「保存できていない」ように見える。 変更は API 応答の行を
  // そのまま反映して整合させる (並び順はバックエンドと同じ規則で並べ直す)。
  const applyRule = (rule: HarnessRule) => setRules((prev) => sortRules(
    prev.some((r) => r.id === rule.id)
      ? prev.map((r) => (r.id === rule.id ? rule : r))
      : [...prev, rule],
  ));

  const mutate = (
    id: string,
    action: () => Promise<unknown>,
    options: { confirmMessage?: string } = {},
  ) =>
    runMutation({
      confirmMessage: options.confirmMessage,
      setBusy: (value) => setBusyId(value ? id : null),
      setError,
      action,
    });

  return (
    <div className="space-y-3">
      <p className="text-subtle text-sm">
        子会社ガードと依頼受付が全依頼を判定するときに参照するポリシー。
        allow = 許可方針 / block = 遮断方針で、 本文はそのままガードプロンプトに自然文として並びます。
        並び順が小さいものから提示されます。 既定ルールは本文の調整と無効化のみ可 (削除不可)。
      </p>

      {error && <div className="text-danger text-sm">{error}</div>}

      {rules.length === 0 && (
        <div className="text-subtle text-sm">
          ルールがまだありません。 Concordia backend の起動時に既定ルールが seed されます。
        </div>
      )}

      {rules.map((rule) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          busy={busyId === rule.id}
          onSave={(draft) => void mutate(
            rule.id,
            () => api.harnessRuleUpdate(rule.id, draft).then((r) => applyRule(r.rule)),
          )}
          onToggle={() => void mutate(
            rule.id,
            () => api.harnessRuleUpdate(rule.id, { enabled: !rule.enabled }).then((r) => applyRule(r.rule)),
          )}
          onRemove={() => void mutate(
            rule.id,
            async () => {
              // builtin は backend が 409 を返す (= del() が throw する) ので、
              // 生の "409 /v1/..." ではなく理由を出す。
              await api.harnessRuleDelete(rule.id).catch((e: unknown) => {
                const message = e instanceof Error ? e.message : String(e);
                throw new Error(message.startsWith("409")
                  ? "既定ルールは削除できません (無効化のみ可)"
                  : message);
              });
              setRules((prev) => prev.filter((r) => r.id !== rule.id));
            },
            { confirmMessage: `ルール「${rule.title || rule.id}」を削除しますか?` },
          )}
        />
      ))}

      <section className="border border-border rounded p-3 space-y-2 bg-muted/40">
        <div className="text-sm font-medium">ルールを追加</div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={adding.kind}
            onChange={(e) => setAdding({ ...adding, kind: e.target.value as "allow" | "block" })}
            className="foundation-form text-sm"
          >
            <option value="block">block (遮断)</option>
            <option value="allow">allow (許可)</option>
          </select>
          <input
            type="text"
            value={adding.title}
            onChange={(e) => setAdding({ ...adding, title: e.target.value })}
            placeholder="タイトル"
            className="foundation-form text-sm flex-1 min-w-40"
          />
          <label className="flex items-center gap-1 text-[11px] text-subtle">
            並び
            <input
              type="number"
              value={adding.sort_order}
              onChange={(e) => setAdding({ ...adding, sort_order: Number(e.target.value) || 0 })}
              className="foundation-form text-sm w-16"
            />
          </label>
        </div>
        <textarea
          value={adding.description}
          onChange={(e) => setAdding({ ...adding, description: e.target.value })}
          placeholder="ガードに渡す自然文ルール"
          className="foundation-form w-full h-20 text-sm"
        />
        <button
          type="button"
          disabled={busyId === "create" || !adding.description.trim()}
          onClick={() => void runMutation({
            setBusy: (value) => setBusyId(value ? "create" : null),
            setError,
            action: () => api.harnessRuleCreate(adding),
            onSuccess: (created) => {
              setAdding({ kind: "block", title: "", description: "", sort_order: 0 });
              applyRule(created.rule);
            },
          })}
          className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
        >
          追加
        </button>
      </section>
    </div>
  );
}
