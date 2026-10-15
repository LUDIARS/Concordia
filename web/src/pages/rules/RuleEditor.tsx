import { useState } from "react";
import { rulesApi, type PatrolActionConfig, type RuleView, type SourceView } from "./rules-api.js";

// 巡回 rule の型付きフォーム (spec/feature/patrol-chat.md §9)。 上級者向けの JSON 編集も同じ
// schema でサーバが検証する。 任意コード・URL・credential は入力させない (素材元は登録済みから選ぶ)。

const CHANNELS = ["chitchat", "報告", "ぼやき"] as const;
const SCOPES = ["hq", "public"] as const;

const DEFAULT_CONFIG: PatrolActionConfig = {
  kind: "material-chat",
  source_ids: [],
  scope_key: "hq",
  filters: { genres: [], max_age_sec: 86400 },
  renderer: "oneshot",
  max_chars: 240,
  root_limit_per_day: 8,
  llm_limit_per_day: 16,
  followup: {
    reply_enabled: true,
    reaction_threshold: 3,
    later_message_threshold: 4,
    min_wait_sec: 600,
    window_sec: 21600,
    max_unprompted: 1,
    max_replies: 4,
  },
};

interface Props {
  rule: RuleView | null;
  sources: SourceView[];
  onSaved: (rule: RuleView) => void;
  onCancel: () => void;
}

const splitList = (text: string): string[] => text.split(/[,\s、]+/).map((s) => s.trim()).filter(Boolean);

export function RuleEditor({ rule, sources, onSaved, onCancel }: Props) {
  const initial = rule?.action_config ?? DEFAULT_CONFIG;
  const [id, setId] = useState(rule?.id ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [instructions, setInstructions] = useState(rule?.instructions ?? "素材から一つ、短い感想と出典を添える。");
  const [target, setTarget] = useState(rule?.target ?? "chitchat");
  const [triggerType, setTriggerType] = useState<"tick" | "event">(rule?.trigger_type ?? "tick");
  const [tickSec, setTickSec] = useState(rule?.tick_sec ?? 1800);
  const [config, setConfig] = useState<PatrolActionConfig>({ ...DEFAULT_CONFIG, ...initial, followup: { ...DEFAULT_CONFIG.followup, ...initial.followup } });
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patchConfig = (p: Partial<PatrolActionConfig>) => setConfig((c) => ({ ...c, ...p }));
  const patchFollowup = (p: Partial<PatrolActionConfig["followup"]>) => setConfig((c) => ({ ...c, followup: { ...c.followup, ...p } }));

  const save = async () => {
    let actionConfig: unknown = config;
    if (jsonMode) {
      try { actionConfig = JSON.parse(jsonText); } catch { setError("JSON が読めません"); return; }
    }
    const body: Record<string, unknown> = {
      description: description || null,
      instructions,
      target,
      trigger_type: triggerType,
      tick_sec: triggerType === "tick" ? tickSec : null,
      event_kind: triggerType === "event" ? "service.event" : null,
      cooldown_sec: Math.min(tickSec, 86400),
      config_version: 2,
      action_config: actionConfig,
    };
    setSaving(true);
    const res = rule
      ? await rulesApi.update(rule.id, { ...body, expected_revision: rule.revision })
      : await rulesApi.create({ id, ...body });
    setSaving(false);
    if (!res.ok) {
      setError(res.status === 409 ? "他の変更と競合しました。 一覧を読み直してから編集してください。" : `保存できません: ${res.error}`);
      return;
    }
    setError(null);
    onSaved(res.data.rule);
  };

  return (
    <div className="border border-border rounded p-3 space-y-3 bg-surface" data-testid="rule-editor">
      <h3 className="font-semibold text-sm">{rule ? `編集: ${rule.id} (rev ${rule.revision})` : "巡回ルールを追加"}</h3>
      {rule?.execution_mode === "legacy-observe" && (
        <p className="text-xs text-subtle">旧ルール (投稿しない) を巡回ルールへ移します。 保存しても無効のままです。</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {!rule && (
          <label className="space-y-1">
            <span className="text-[11px] text-subtle block">ID</span>
            <input className="foundation-form text-sm w-full" value={id} onChange={(e) => setId(e.target.value)} placeholder="tendentia-tech-patrol" />
          </label>
        )}
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">説明</span>
          <input className="foundation-form text-sm w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">投稿先</span>
          <select className="foundation-form text-sm w-full" value={target} onChange={(e) => setTarget(e.target.value)}>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">きっかけ</span>
          <select className="foundation-form text-sm w-full" value={triggerType} onChange={(e) => setTriggerType(e.target.value as "tick" | "event")}>
            <option value="tick">定期 (素材から話題を選ぶ)</option>
            <option value="event">サービスの出来事 (短い報告)</option>
          </select>
        </label>
        {triggerType === "tick" && (
          <label className="space-y-1">
            <span className="text-[11px] text-subtle block">間隔 (秒)</span>
            <input type="number" className="foundation-form text-sm w-full" value={tickSec} min={60} max={86400} onChange={(e) => setTickSec(Number(e.target.value))} />
          </label>
        )}
      </div>
      <label className="space-y-1 block">
        <span className="text-[11px] text-subtle block">追加の方針 (短文生成への指示)</span>
        <textarea className="foundation-form text-sm w-full" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>

      <div className="flex items-center gap-2 text-xs">
        <button type="button" className="underline" onClick={() => { setJsonText(JSON.stringify(config, null, 2)); setJsonMode((v) => !v); }}>
          {jsonMode ? "フォームで編集" : "JSON で編集"}
        </button>
      </div>

      {jsonMode ? (
        <textarea className="foundation-form text-xs font-mono w-full" rows={14} value={jsonText} onChange={(e) => setJsonText(e.target.value)} aria-label="action_config JSON" />
      ) : (
        <div className="space-y-3">
          <fieldset className="space-y-1">
            <legend className="text-[11px] text-subtle">素材元</legend>
            {sources.map((s) => (
              <label key={s.sourceId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={s.reason === "contract-unverified"}
                  checked={config.source_ids.includes(s.sourceId)}
                  onChange={(e) => patchConfig({
                    source_ids: e.target.checked ? [...config.source_ids, s.sourceId] : config.source_ids.filter((x) => x !== s.sourceId),
                  })}
                />
                {s.label}
                {s.status !== "ready" && <span className="text-xs text-subtle">({s.reason})</span>}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">共有範囲</span>
              <select className="foundation-form text-sm w-full" value={config.scope_key} onChange={(e) => patchConfig({ scope_key: e.target.value })}>
                {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">ジャンル (カンマ区切り)</span>
              <input className="foundation-form text-sm w-full" value={(config.filters.genres ?? []).join(", ")}
                onChange={(e) => patchConfig({ filters: { ...config.filters, genres: splitList(e.target.value) } })} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">サービス (イベント用、カンマ区切り)</span>
              <input className="foundation-form text-sm w-full" value={(config.filters.service_codes ?? []).join(", ")}
                onChange={(e) => patchConfig({ filters: { ...config.filters, service_codes: splitList(e.target.value) } })} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">生成方式</span>
              <select className="foundation-form text-sm w-full" value={config.renderer} onChange={(e) => patchConfig({ renderer: e.target.value as "oneshot" | "template" })}>
                <option value="oneshot">短文生成 (1 回)</option>
                <option value="template">決まった型の文</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">1 日の投稿上限</span>
              <input type="number" className="foundation-form text-sm w-full" value={config.root_limit_per_day} onChange={(e) => patchConfig({ root_limit_per_day: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">1 日の生成上限</span>
              <input type="number" className="foundation-form text-sm w-full" value={config.llm_limit_per_day} onChange={(e) => patchConfig({ llm_limit_per_day: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">反応の人数で追投稿</span>
              <input type="number" className="foundation-form text-sm w-full" value={config.followup.reaction_threshold} onChange={(e) => patchFollowup({ reaction_threshold: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">後続の発言数で追投稿</span>
              <input type="number" className="foundation-form text-sm w-full" value={config.followup.later_message_threshold} onChange={(e) => patchFollowup({ later_message_threshold: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-subtle block">返信への応答上限 (会話ごと)</span>
              <input type="number" className="foundation-form text-sm w-full" value={config.followup.max_replies} onChange={(e) => patchFollowup({ max_replies: Number(e.target.value) })} />
            </label>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="px-3 py-1 rounded bg-accent text-white text-sm" disabled={saving} onClick={() => void save()}>保存</button>
        <button type="button" className="px-3 py-1 rounded border border-border text-sm" onClick={onCancel}>閉じる</button>
      </div>
    </div>
  );
}
