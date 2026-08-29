import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs, api, statusBadge, type ModelCatalogItem, type SessionRow } from "../api.js";
import { RuntimeOptionsBuilder } from "../components/RuntimeOptionsBuilder.js";
import { CATEGORIES, CATEGORY_LABELS, EMPTY_FORM, type Category, type Provider } from "./delegation/model.js";
import { OutsourcedRunCard, fmtDelegationTs, runSummary } from "./delegation/RunCards.js";
import { useDelegationState } from "./delegation/useDelegationState.js";
import { TemplateOverrides } from "./delegation/TemplateOverrides.js";

export function Delegation() {
  const { templates, models, runs, includeInactive, setIncludeInactive, mode, setMode, form, setForm, formRuntimeOptions, setFormRuntimeOptions, formError, forumTagSyncMessage, busy, invokeFor, setInvokeFor, invokeArgs, setInvokeArgs, invokeOptionsJson, setInvokeOptionsJson, invokeCwd, setInvokeCwd, invokeResult, setInvokeResult, importText, setImportText, queue, queueLimitDraft, setQueueLimitDraft, saveQueueLimit, safeRuntimeOptions, optionValueForJson, setFormRuntimeOption, startCreate, startEdit, submit, copyJson, importJson, deactivate, moveTemplate, syncForumTags, openInvoke, runInvoke, outsourcedRuns, queuedRuns, activeOutsourced, finishedOutsourced, refresh } = useDelegationState();
  // カテゴリ表示絞り込み ("" = 全カテゴリ)。 表示だけの絞り込みで、 並び替え (↑↓) は
  // 全体の sort_order を書き換えるため絞り込み中は無効化する。
  const [categoryFilter, setCategoryFilter] = useState<Category | "">("");
  const [overrideTemplateId, setOverrideTemplateId] = useState<string | null>(null);
  const visibleTemplates = categoryFilter ? templates.filter((t) => t.category === categoryFilter) : templates;
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Delegation Templates</h1>
        <p className="text-subtle text-sm">
          AI エージェント間のタスク委託テンプレ。 call_name で MCP / CLI / Web から呼び出すと、
          Concordia がプロンプトを render して新しい Codex / Claude / Gemini セッションを spawn する。
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Templates</h2>
          <label className="text-sm text-subtle flex items-center gap-1">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            include inactive
          </label>
          <select
            className="foundation-form text-sm"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as Category | "")}
            title="雇用形態カテゴリで絞り込み"
          >
            <option value="">全カテゴリ</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <button
            onClick={startCreate}
            className="ml-auto bg-accent text-bg px-3 py-1.5 rounded text-sm font-medium"
          >+ New template</button>
          <button
            onClick={() => setImportText(importText === null ? "" : null)}
            className="border border-border px-3 py-1.5 rounded text-sm"
            title="可搬 JSON を貼り付けてテンプレを作成"
          >貼付で作成</button>
          <button
            onClick={syncForumTags}
            disabled={busy}
            className="border border-border px-3 py-1.5 rounded text-sm disabled:opacity-50"
            title="forum_tag が有効なテンプレを Discord Session フォーラムへ同期"
          >フォーラムタグ更新</button>
        </div>
        {forumTagSyncMessage && <div className="text-xs text-subtle">{forumTagSyncMessage}</div>}

        {importText !== null && (
          <div className="mb-3 rounded border border-border bg-surface p-3 space-y-2">
            <div className="text-xs text-subtle">📋JSON でコピーした可搬 delegation を貼り付け → 作成 (call_name は自動採番)</div>
            <textarea
              className="foundation-form w-full font-mono text-xs"
              rows={6}
              placeholder='{"kind":"concordia.delegation","call_name":"...","target_provider":"claude", ...}'
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="bg-accent text-bg px-3 py-1 rounded text-sm" disabled={busy || !importText.trim()} onClick={importJson}>作成</button>
              <button className="border border-border px-3 py-1 rounded text-sm" onClick={() => setImportText(null)}>閉じる</button>
            </div>
          </div>
        )}

        <table className="w-full text-sm">
          <thead className="text-xs text-subtle">
            <tr>
              <th className="text-left p-2">call_name</th>
              <th className="text-left p-2">title</th>
              <th className="text-right p-2">order</th>
              <th className="text-left p-2" title="従業員=spawn / フリーランサー=caller / パートタイマー=時限起動">category</th>
              <th className="text-left p-2">provider</th>
              <th className="text-left p-2">model</th>
              <th className="text-center p-2">emoji</th>
              <th className="text-center p-2">active</th>
              <th className="text-center p-2" title="call_only=true はスポーン選択肢に出ない">call only</th>
              <th className="text-center p-2" title="Session フォーラムの spawn-by-post タグ">forum</th>
              <th className="text-left p-2">updated</th>
              <th className="text-right p-2">actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleTemplates.map((t, i) => (
              <Fragment key={t.id}>
              <tr className="border-t border-border">
                <td className="p-2 font-mono">{t.call_name}</td>
                <td className="p-2">{t.title}</td>
                <td className="p-2 text-right text-xs text-subtle">{t.sort_order}</td>
                <td className="p-2 text-xs">{CATEGORY_LABELS[t.category] ?? t.category}</td>
                <td className="p-2"><code>{t.target_provider}</code></td>
                <td className="p-2 text-xs">{t.model ? <code>{t.model}</code> : <span className="text-subtle">—</span>}</td>
                <td className="p-2 text-center">{t.emoji || <span className="text-subtle">—</span>}</td>
                <td className="p-2 text-center">{t.is_active ? "✓" : "—"}</td>
                <td className="p-2 text-center">{t.call_only ? "✓" : "—"}</td>
                <td className="p-2 text-center">{t.forum_tag ? "✓" : "—"}</td>
                <td className="p-2 text-xs text-subtle">{fmtDelegationTs(t.updated_at)}</td>
                <td className="p-2 text-right space-x-2">
                  <button className="text-xs" disabled={busy || categoryFilter !== "" || i === 0} title={categoryFilter ? "絞り込み中は並び替え不可" : "Move up"} onClick={() => moveTemplate(i, -1)}>↑</button>
                  <button className="text-xs" disabled={busy || categoryFilter !== "" || i === templates.length - 1} title={categoryFilter ? "絞り込み中は並び替え不可" : "Move down"} onClick={() => moveTemplate(i, 1)}>↓</button>
                  <button className="text-accent text-xs" onClick={() => openInvoke(t)}>invoke</button>
                  <button className="text-xs" onClick={() => startEdit(t)}>edit</button>
                  <button className="text-xs" title="可搬 JSON をクリップボードにコピー" onClick={() => copyJson(t)}>📋JSON</button>
                  <button className="text-xs" onClick={() => setOverrideTemplateId(overrideTemplateId === t.id ? null : t.id)}>overrides</button>
                  <button className="text-red-500 text-xs" onClick={() => deactivate(t.id)}>deactivate</button>
                </td>
              </tr>
              {overrideTemplateId === t.id && <tr><td colSpan={12} className="p-2"><TemplateOverrides template={t} onChanged={refresh} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      {mode && (
        <section className="rounded border border-border bg-surface p-4 space-y-3">
          <h3 className="text-base font-semibold">
            {mode.kind === "edit" ? "Edit template" : "New template"}
          </h3>
          {formError && <div className="text-red-500 text-sm">{formError}</div>}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span className="text-subtle">call_name (^[a-z][a-z0-9_-]{"{0,63}"}$)</span>
              <input
                className="foundation-form w-full"
                value={form.call_name}
                disabled={mode.kind === "edit"}
                onChange={(e) => setForm({ ...form, call_name: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">title</span>
              <input
                className="foundation-form w-full"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">description</span>
              <input
                className="foundation-form w-full"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">target_provider</span>
              <select
                className="foundation-form w-full"
                value={form.target_provider}
                onChange={(e) => setForm({ ...form, target_provider: e.target.value as Provider })}
              >
                <option value="codex">codex</option>
                <option value="codex-sdk">codex-sdk (Satelles headless)</option>
                <option value="claude">claude</option>
                <option value="gemini">gemini</option>
                <option value="gemma4-12">gemma4-12 (ローカル LLM / Ollama)</option>
              </select>
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">model (optional)</span>
              {(() => {
                // provider に紐づく候補 (provider 一致 + 'any') を sort_order 順で。
                // codex-sdk は codex ファミリで同じ OpenAI モデルを使うため、
                // model_catalog は codex の行を共有する (専用行は持たない)。
                const catalogProvider = form.target_provider === "codex-sdk"
                  ? "codex"
                  : form.target_provider;
                const opts = models.filter(
                  (m) => m.provider === "any" || m.provider === catalogProvider,
                );
                // 既存テンプレが catalog に無いモデルを持つ場合、 値を失わないよう
                // 末尾に現値を補う (編集時の互換)。
                const known = new Set(opts.map((m) => m.model_id));
                const hasCurrent = form.model.trim() !== "";
                return (
                  <>
                    <select
                      className="foundation-form w-full"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                    >
                      <option value="">(provider CLI 既定)</option>
                      {opts.map((m) => (
                        <option key={m.id} value={m.model_id}>
                          {m.label ? `${m.label} — ${m.model_id}` : m.model_id}
                          {m.provider !== "any" ? "" : " (any)"}
                        </option>
                      ))}
                      {hasCurrent && !known.has(form.model) && (
                        <option value={form.model}>{form.model} (未登録)</option>
                      )}
                    </select>
                    {models.length === 0 && (
                      <span className="text-xs text-subtle">
                        モデル候補が未登録です。 設定 → モデルカタログ で追加できます。
                      </span>
                    )}
                  </>
                );
              })()}
            </label>
            <div className="text-sm space-y-2 col-span-2 rounded border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-subtle">default runtime options</span>
                <span className="text-xs text-subtle">
                  {formRuntimeOptions.length > 0
                    ? `${form.target_provider}${form.model.trim() ? ` / ${form.model.trim()}` : ""}`
                    : "no suggestions for selected provider/model"}
                </span>
              </div>
              <RuntimeOptionsBuilder
                suggestions={formRuntimeOptions}
                json={form.runtime_options_json}
                onJsonChange={(j) => setForm({ ...form, runtime_options_json: j })}
              />
              <label className="block space-y-1">
                <span className="text-subtle">runtime_options JSON</span>
                <textarea
                  className="foundation-form w-full font-mono text-xs"
                  rows={4}
                  value={form.runtime_options_json}
                  onChange={(e) => setForm({ ...form, runtime_options_json: e.target.value })}
                />
              </label>
            </div>
            <label className="text-sm space-y-1">
              <span className="text-subtle">default_cwd (optional)</span>
              <input
                className="foundation-form w-full"
                value={form.default_cwd}
                onChange={(e) => setForm({ ...form, default_cwd: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">project (対象プロジェクト名、省略可)</span>
              <input
                className="foundation-form w-full"
                value={form.project}
                onChange={(e) => setForm({ ...form, project: e.target.value })}
                placeholder="Pictor"
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">category (雇用形態)</span>
              <select
                className="foundation-form w-full"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
              >
                <option value="employee">従業員 — セッションワーカー (spawn で起動)</option>
                <option value="freelancer">フリーランサー — caller で呼び出す特化型タスク</option>
                <option value="parttimer">パートタイマー — 時限起動するタスク</option>
                <option value="test-qa">テスト・QA — Test Forum の投稿検知で自動起動する検証タスク</option>
              </select>
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">sort_order</span>
              <input
                className="foundation-form w-full"
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">prompt_template (${'{var}'} or ${'{var:default}'})</span>
              <textarea
                className="foundation-form w-full font-mono text-xs"
                rows={10}
                value={form.prompt_template}
                onChange={(e) => setForm({ ...form, prompt_template: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">
                input_schema (JSON array of {"{name,type,required,description?,default?}"})
              </span>
              <textarea
                className="foundation-form w-full font-mono text-xs"
                rows={6}
                value={form.input_schema_json}
                onChange={(e) => setForm({ ...form, input_schema_json: e.target.value })}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-subtle">emoji (チャット表示用、省略可)</span>
              <input
                className="foundation-form w-full"
                value={form.emoji}
                onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                placeholder="🧙‍♂️"
                maxLength={8}
              />
            </label>
            <div className="text-sm flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                <span>is_active</span>
              </label>
              <label className="flex items-center gap-2" title="LLM 委託専用。 Discord/Slack の spawn ドロップダウンに出さない">
                <input
                  type="checkbox"
                  checked={form.call_only}
                  onChange={(e) => setForm({ ...form, call_only: e.target.checked })}
                />
                <span>call_only</span>
              </label>
              <label className="flex items-center gap-2" title="Session フォーラムから投稿で起動できるテンプレ (最大10)">
                <input
                  type="checkbox"
                  checked={form.forum_tag}
                  onChange={(e) => setForm({ ...form, forum_tag: e.target.checked })}
                />
                <span>forum_tag</span>
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            >Save</button>
            <button
              onClick={() => { setMode(null); setForm(EMPTY_FORM); setFormRuntimeOptions([]); }}
              disabled={busy}
              className="text-sm px-4 py-1.5 rounded border border-border"
            >Cancel</button>
          </div>
        </section>
      )}

      {invokeFor && (
        <section className="rounded border border-border bg-surface p-4 space-y-3">
          <h3 className="text-base font-semibold">Invoke {invokeFor.call_name}</h3>
          <p className="text-xs text-subtle">{invokeFor.description}</p>
          <div className="grid grid-cols-2 gap-3">
            {invokeFor.input_schema.map((s) => (
              <label key={s.name} className="text-sm space-y-1">
                <span className="text-subtle">
                  {s.name} <span className="font-mono text-xs">{s.type}</span>
                  {s.required && <span className="text-red-500"> *</span>}
                  {s.description && <div className="text-xs text-subtle">{s.description}</div>}
                </span>
                <input
                  className="foundation-form w-full"
                  value={invokeArgs[s.name] ?? ""}
                  onChange={(e) => setInvokeArgs({ ...invokeArgs, [s.name]: e.target.value })}
                />
              </label>
            ))}
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">cwd (optional override)</span>
              <input
                className="foundation-form w-full"
                value={invokeCwd}
                onChange={(e) => setInvokeCwd(e.target.value)}
              />
            </label>
            <div className="col-span-2">
              <RuntimeOptionsBuilder
                suggestions={invokeFor.runtime_options ?? []}
                json={invokeOptionsJson}
                onJsonChange={setInvokeOptionsJson}
              />
            </div>
            <label className="text-sm space-y-1 col-span-2">
              <span className="text-subtle">runtime options JSON</span>
              <textarea
                className="foundation-form w-full font-mono text-xs"
                rows={3}
                value={invokeOptionsJson}
                onChange={(e) => setInvokeOptionsJson(e.target.value)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runInvoke}
              disabled={busy}
              className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            >Spawn</button>
            <button
              onClick={() => { setInvokeFor(null); setInvokeResult(null); }}
              disabled={busy}
              className="text-sm px-4 py-1.5 rounded border border-border"
            >Close</button>
          </div>
          {invokeResult !== null && (
            <pre className="text-xs bg-bg p-3 rounded overflow-auto max-h-96">
              {JSON.stringify(invokeResult, null, 2)}
            </pre>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">外注(作業委託)</h2>
          <span className="text-xs text-subtle">{outsourcedRuns.length} tasks</span>
        </div>

        {/* 実行キュー: 同時実行上限を超えた invoke は起動せず queued で待ち、 空き次第 FIFO で走る。 */}
        {queue && (
          <div className="border border-border rounded p-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">実行キュー</span>
            <span className="text-subtle text-xs">
              実行中 {queue.active}
              {queue.max_concurrency > 0 ? ` / ${queue.max_concurrency}` : " / 無制限"}
              {" · "}待ち {queue.queued}
            </span>
            <label className="flex items-center gap-1 text-xs ml-auto">
              <span className="text-subtle">同時実行上限 (0=無制限)</span>
              <input
                className="foundation-form w-20"
                type="number"
                min={0}
                max={64}
                value={queueLimitDraft}
                onChange={(e) => setQueueLimitDraft(e.target.value)}
              />
              <button className="border border-border rounded px-2 py-1" onClick={saveQueueLimit}>保存</button>
            </label>
          </div>
        )}

        {queuedRuns.length > 0 && (
          <div className="border border-border rounded p-3 space-y-1">
            <div className="text-sm font-medium">順番待ち ({queuedRuns.length})</div>
            {queuedRuns.map((r) => (
              <div key={r.id} className="text-xs text-subtle flex gap-2">
                <span className="font-mono">{r.queue_position ?? "-"}.</span>
                <span className="text-fg">{r.call_name}</span>
                <span className="truncate">{runSummary(r)}</span>
                <span className="ml-auto shrink-0">{fmtTs(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
        {outsourcedRuns.length === 0 ? (
          <div className="border border-border rounded p-3 text-sm text-subtle">外注タスクはありません</div>
        ) : (
          <>
            <div className="grid gap-2">
              {activeOutsourced.map((r) => <OutsourcedRunCard key={r.id} run={r} />)}
              {activeOutsourced.length === 0 && (
                <div className="border border-border rounded p-3 text-sm text-subtle">進行中の外注はありません</div>
              )}
            </div>

            {/* 完了した外注も残す (run 行は purge されない)。 何を誰にいつ委託したかの履歴。 */}
            {finishedOutsourced.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-subtle">完了・履歴 ({finishedOutsourced.length})</div>
                <div className="grid gap-2 opacity-80">
                  {finishedOutsourced.map((r) => <OutsourcedRunCard key={r.id} run={r} />)}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <table className="w-full text-sm">
          <thead className="text-xs text-subtle">
            <tr>
              <th className="text-left p-2">call_name</th>
              <th className="text-left p-2">status</th>
              <th className="text-left p-2">spawn pid</th>
              <th className="text-left p-2">triggered_by</th>
              <th className="text-left p-2">created</th>
              <th className="text-left p-2">prompt file</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-2 font-mono text-xs">{r.call_name}</td>
                <td className="p-2"><code>{r.status}</code></td>
                <td className="p-2">{r.spawn_pid ?? "—"}</td>
                <td className="p-2 text-xs">{r.triggered_by ?? "—"}</td>
                <td className="p-2 text-xs text-subtle">{fmtDelegationTs(r.created_at)}</td>
                <td className="p-2 text-xs font-mono">{r.prompt_file_path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
