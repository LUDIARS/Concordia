// @implements SPEC-DEPT-WEBUI
import { useState, type ReactNode } from "react";

import {
  api,
  type Department,
  type DepartmentAudience,
  type DepartmentOutputItem,
  type DepartmentOutputMode,
  type DepartmentSettings,
  type DepartmentWrite,
  type UseCase,
} from "../../api.js";

// 1 部署の編集フォーム (spec/feature/departments.md §5 / §9)。 起動既定値・担当プロジェクト・
// 出力方針・ユースケース・既定部署・ルール本文をまとめて保存する。

const OUTPUT_ITEMS: Array<{ key: DepartmentOutputItem; label: string }> = [
  { key: "thinking", label: "途中の思考" },
  { key: "status_card", label: "状態カード" },
  { key: "session_info_card", label: "セッション情報表示" },
  { key: "cost_report", label: "コスト報告" },
  { key: "intermediate", label: "AI の途中発言（出さない＝最終回答のみ）" },
  { key: "inject_transcript", label: "Cc の指令（inject）" },
  { key: "context_usage", label: "コンテキスト使用量" },
  { key: "session_end_report", label: "セッション終了報告" },
  { key: "working_post", label: "「作業中…」の投稿" },
];

const OUTPUT_MODES: Array<{ value: DepartmentOutputMode; label: string }> = [
  { value: "inherit", label: "全体設定に従う" },
  { value: "on", label: "出す" },
  { value: "off", label: "出さない" },
];

const PROVIDERS = ["claude", "codex", "codex-sdk", "gemini", "gemma4-12"];

type LaunchKind = "none" | "template" | "provider";

export const EMPTY_SETTINGS: DepartmentSettings = {
  launch: {},
  projects: [],
  output: { thinking: "inherit", status_card: "inherit", session_info_card: "inherit", cost_report: "inherit" },
  private: { enabled: false, approver_min_role: "manager" },
};

export function DepartmentEditor({
  department,
  useCases,
  onSaved,
  client = api,
}: {
  department: Department;
  useCases: UseCase[];
  onSaved: (department: Department) => void;
  /** 保存の口。 テストは偽物を渡す (vitest のモジュール共有で vi.mock が他ファイルのモックに負けるため)。 */
  client?: Pick<typeof api, "departmentUpdate">;
}) {
  const initial = department.settings ?? EMPTY_SETTINGS;
  const [name, setName] = useState(department.name);
  const [slug, setSlug] = useState(department.slug);
  const [description, setDescription] = useState(department.description);
  const [sortOrder, setSortOrder] = useState(String(department.sort_order));
  const [useCaseId, setUseCaseId] = useState(department.use_case_id ?? "");
  const [isDefault, setIsDefault] = useState(department.is_default);
  const [launchKind, setLaunchKind] = useState<LaunchKind>(
    initial.launch.template ? "template" : initial.launch.provider ? "provider" : "none",
  );
  const [template, setTemplate] = useState(initial.launch.template ?? "");
  const [provider, setProvider] = useState(initial.launch.provider ?? "claude");
  const [model, setModel] = useState(initial.launch.model ?? "");
  const [effort, setEffort] = useState(initial.launch.reasoning_effort ?? "");
  const [defaultProject, setDefaultProject] = useState(initial.launch.project ?? "");
  const [projects, setProjects] = useState(initial.projects.join(", "));
  const [output, setOutput] = useState(initial.output);
  const [privateConsult, setPrivateConsult] = useState(initial.private ?? { enabled: false, approver_min_role: "manager" as const });
  const [costMultiplier, setCostMultiplier] = useState(String(initial.budget?.cost_multiplier ?? 1));
  const [audience, setAudience] = useState<DepartmentAudience>(initial.audience ?? "standard");
  const [rulesText, setRulesText] = useState(department.rules_text);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // 画面に項目の無い設定 (startup_inject・auto_check など) を落とさないよう、 保存済みの設定を土台にする。
  // 落とすとサーバーが既定値に戻し、 相談課の「初回だけの注入」「自動確認なし」が外れる。
  const buildSettings = (): DepartmentSettings => ({
    ...initial,
    launch: {
      ...(launchKind === "template" && template.trim() ? { template: template.trim() } : {}),
      ...(launchKind === "provider" ? { provider } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(effort.trim() ? { reasoning_effort: effort.trim() } : {}),
      ...(defaultProject.trim() ? { project: defaultProject.trim() } : {}),
    },
    projects: projects.split(",").map((value) => value.trim()).filter(Boolean),
    output,
    private: privateConsult,
    budget: { cost_multiplier: Number(costMultiplier) },
    audience,
  });

  const save = async () => {
    const multiplier = Number(costMultiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10) {
      setMessage({ ok: false, text: "予算のコスト倍率は 0 より大きく 10 以下で入力してください" });
      return;
    }
    setBusy(true);
    setMessage(null);
    const body: DepartmentWrite = {
      name: name.trim(),
      slug: slug.trim(),
      description,
      sort_order: Number(sortOrder) || 0,
      use_case_id: useCaseId || null,
      is_default: isDefault,
      settings: buildSettings(),
      rules_text: rulesText,
    };
    try {
      const r = await client.departmentUpdate(department.id, body);
      onSaved(r.department);
      setMessage({ ok: true, text: "保存しました" });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const forumState = department.is_default
    ? "既定部署は Session フォーラムを使います"
    : department.discord_forum_id ? `フォーラム作成済み (${department.discord_forum_id})` : "フォーラムは Bot が次の反映で作成します";

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 md:grid-cols-2">
        <Labeled label="名前"><input className="foundation-form w-full" value={name} onChange={(e) => setName(e.target.value)} /></Labeled>
        <Labeled label="slug"><input className="foundation-form w-full" value={slug} onChange={(e) => setSlug(e.target.value)} /></Labeled>
        <Labeled label="説明"><input className="foundation-form w-full" value={description} onChange={(e) => setDescription(e.target.value)} /></Labeled>
        <Labeled label="並び順"><input className="foundation-form w-full" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></Labeled>
        <Labeled label="ユースケース">
          <select className="foundation-form w-full" value={useCaseId} onChange={(e) => setUseCaseId(e.target.value)}>
            <option value="">なし</option>
            {useCases.map((useCase) => (
              <option key={useCase.id} value={useCase.id}>{useCase.name} ({useCase.format_name})</option>
            ))}
          </select>
        </Labeled>
        <label className="flex items-center gap-2 text-xs pt-5">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          この会社の既定部署 (部署未指定の起動と Session フォーラムの投稿が入る)
        </label>
      </div>

      <fieldset className="border border-border rounded p-2 space-y-2">
        <legend className="text-xs text-subtle px-1">起動既定値 (明示された項目は上書きしない)</legend>
        <div className="grid gap-2 md:grid-cols-3">
          <Labeled label="起動の種別">
            <select className="foundation-form w-full" value={launchKind} onChange={(e) => setLaunchKind(e.target.value as LaunchKind)}>
              <option value="none">指定なし</option>
              <option value="template">delegation テンプレート</option>
              <option value="provider">provider</option>
            </select>
          </Labeled>
          {launchKind === "template" && (
            <Labeled label="テンプレート (call_name)">
              <input className="foundation-form w-full" value={template} onChange={(e) => setTemplate(e.target.value)} />
            </Labeled>
          )}
          {launchKind === "provider" && (
            <Labeled label="provider">
              <select className="foundation-form w-full" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </Labeled>
          )}
          <Labeled label="model"><input className="foundation-form w-full" value={model} onChange={(e) => setModel(e.target.value)} /></Labeled>
          <Labeled label="effort"><input className="foundation-form w-full" value={effort} onChange={(e) => setEffort(e.target.value)} /></Labeled>
          <Labeled label="既定プロジェクト"><input className="foundation-form w-full" value={defaultProject} onChange={(e) => setDefaultProject(e.target.value)} /></Labeled>
        </div>
        <Labeled label="担当プロジェクト (カンマ区切り。空なら制限しない)">
          <input className="foundation-form w-full" value={projects} onChange={(e) => setProjects(e.target.value)} />
        </Labeled>
      </fieldset>

      <fieldset className="border border-border rounded p-2">
        <legend className="text-xs text-subtle px-1">出力方針</legend>
        <p className="text-xs text-subtle mb-2">この会社のこの部署にだけ適用します。子会社の総務は既定で最終回答のみ、本社は全表示です。</p>
        <div className="flex gap-2 mb-2">
          <button type="button" className="text-xs text-accent" onClick={() => setOutput({ ...output, thinking: "off", intermediate: "off", inject_transcript: "off", context_usage: "off" })}>最終回答のみ</button>
          <button type="button" className="text-xs text-accent" onClick={() => setOutput({ ...output, thinking: "on", intermediate: "on", inject_transcript: "on", context_usage: "on" })}>すべて表示</button>
        </div>
        <div className="grid gap-2 md:grid-cols-4">
          {OUTPUT_ITEMS.map((item) => (
            <Labeled key={item.key} label={item.label}>
              <select
                className="foundation-form w-full"
                value={output[item.key] ?? "inherit"}
                onChange={(e) => setOutput({ ...output, [item.key]: e.target.value as DepartmentOutputMode })}
              >
                {OUTPUT_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
              </select>
            </Labeled>
          ))}
        </div>
      </fieldset>

      <fieldset className="border border-border rounded p-2 space-y-2">
        <legend className="text-xs text-subtle px-1">話し方</legend>
        <Labeled label="人に向けた返信の書き方 (起動時の前提データに足す。作業規則や承認は変わらない)">
          <select
            className="foundation-form"
            aria-label="話し方"
            value={audience}
            onChange={(e) => setAudience(e.target.value as DepartmentAudience)}
          >
            <option value="standard">標準</option>
            <option value="non-engineer">非エンジニア向け (用語を噛み砕き、やったこと／決めてほしいことをまとめる)</option>
          </select>
        </Labeled>
      </fieldset>

      <fieldset className="border border-border rounded p-2 space-y-2">
        <legend className="text-xs text-subtle px-1">プライベート相談</legend>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={privateConsult.enabled}
            onChange={(e) => setPrivateConsult({ ...privateConsult, enabled: e.target.checked })}
          />
          `/consult` で閉じたチャンネルの相談を受け付ける (本社の部署のみ)
        </label>
        <Labeled label="自動で閲覧者に加える権限者 (社員名簿の役職)">
          <select
            className="foundation-form"
            value={privateConsult.approver_min_role}
            onChange={(e) => setPrivateConsult({ ...privateConsult, approver_min_role: e.target.value as "manager" | "executive" })}
          >
            <option value="manager">管理職以上</option>
            <option value="executive">執行役員のみ</option>
          </select>
        </Labeled>
      </fieldset>

      <fieldset className="border border-border rounded p-2 space-y-2">
        <legend className="text-xs text-subtle px-1">月次予算</legend>
        <Labeled label="コスト倍率 (この部署のセッションの消費 × 倍率を予算から引く。既定 1)">
          <input
            type="text"
            inputMode="decimal"
            aria-label="予算のコスト倍率"
            className="foundation-form w-24"
            value={costMultiplier}
            onChange={(e) => setCostMultiplier(e.target.value)}
          />
        </Labeled>
      </fieldset>

      <Labeled label="部署ルール (着手前ルール供給で全体ルールの後・チームルールの前に並ぶ)">
        <textarea className="foundation-form w-full min-h-[96px] font-mono text-xs" value={rulesText} onChange={(e) => setRulesText(e.target.value)} />
      </Labeled>

      <div className="flex items-center gap-3">
        <button type="button" className="px-3 py-1.5 rounded bg-accent text-white text-sm disabled:opacity-50" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <span className="text-xs text-subtle">{forumState}</span>
        {department.settings_error && <span className="text-xs text-danger">保存済み設定が壊れています: {department.settings_error}</span>}
        {message && <span className={`text-xs ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</span>}
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-subtle">{label}</span>
      {children}
    </label>
  );
}
