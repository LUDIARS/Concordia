// @implements SPEC-DLG-PROFILES
import { useEffect, useState } from "react";

import { api, type RequesterProfile, type SubsidiarySummary } from "../api.js";

// 依頼者メモ (spec/feature/dialogue-context.md §7)。 投稿ユーザーごとの技術者レベル・やっていること・
// メモを会社ごとに編集する。 部署フォーラムの新しい投稿者は空のメモ行として自動で並ぶ。
// ここの内容は Cc のローカル DB にだけあり、使う設定のユースケースの起動時にだけ渡る。

const HEAD_OFFICE = "";

export function RequesterProfiles() {
  const [organization, setOrganization] = useState(HEAD_OFFICE);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiarySummary[]>([]);
  const [profiles, setProfiles] = useState<RequesterProfile[]>([]);
  const [newUserId, setNewUserId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.subsidiariesList().then((r) => setSubsidiaries(r.subsidiaries)).catch(() => setSubsidiaries([]));
  }, []);

  const refresh = async () => {
    try {
      setProfiles((await api.requesterProfilesList(organization || null)).profiles);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, [organization]);

  const add = async () => {
    try {
      await api.requesterProfileSave({ subsidiary_id: organization || null, platform: "discord", platform_user_id: newUserId.trim() });
      setNewUserId("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 max-w-5xl">
      <header>
        <h1 className="text-lg font-semibold">依頼者メモ</h1>
        <p className="text-subtle text-sm mt-1">
          投稿ユーザーの技術者レベルややっていることを書いておくと、依頼者メモを使うユースケース
          (一問一答 Q&A・壁打ち相談) の回答がその人に合わせた粒度になります。Cc の外へは出しません。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-subtle block">会社</span>
          <select className="foundation-form text-sm" value={organization} onChange={(e) => setOrganization(e.target.value)}>
            <option value={HEAD_OFFICE}>本社</option>
            {subsidiaries.map((s) => <option key={s.id} value={s.id}>{s.display_name || s.name}</option>)}
          </select>
        </label>
        <input className="foundation-form text-sm" placeholder="Discord ユーザー ID" value={newUserId} onChange={(e) => setNewUserId(e.target.value)} />
        <button type="button" className="px-3 py-1.5 rounded bg-accent text-white text-sm disabled:opacity-50"
          disabled={!/^\d{5,32}$/.test(newUserId.trim())} onClick={() => void add()}>
          追加
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}
      {profiles.length === 0 && <div className="text-subtle text-sm">この会社の依頼者メモはまだありません。</div>}
      {profiles.map((profile) => (
        <ProfileRow key={profile.id} profile={profile} onChanged={() => void refresh()} />
      ))}
    </div>
  );
}

function ProfileRow({ profile, onChanged }: { profile: RequesterProfile; onChanged: () => void }) {
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [skillLevel, setSkillLevel] = useState(profile.skill_level);
  const [activities, setActivities] = useState(profile.activities);
  const [notes, setNotes] = useState(profile.notes);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    try {
      await api.requesterProfileSave({
        subsidiary_id: profile.subsidiary_id,
        platform: profile.platform,
        platform_user_id: profile.platform_user_id,
        display_name: displayName,
        skill_level: skillLevel,
        activities,
        notes,
      });
      setMessage({ ok: true, text: "保存しました" });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  const remove = async () => {
    try {
      await api.requesterProfileDelete(profile.id);
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <section className="border border-border rounded p-3 bg-surface space-y-2 text-sm">
      <div className="flex items-center gap-2 text-xs text-subtle">
        <span>{profile.platform}</span>
        <code>{profile.platform_user_id}</code>
        <button type="button" className="ml-auto text-danger" onClick={() => void remove()}>削除</button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="foundation-form" placeholder="表示名" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input className="foundation-form" placeholder="技術者レベル (例: 初級 / 中級 / 上級)" value={skillLevel} onChange={(e) => setSkillLevel(e.target.value)} />
      </div>
      <textarea className="foundation-form w-full min-h-[60px]" placeholder="やっていること (例: Unity でゲーム開発)"
        value={activities} onChange={(e) => setActivities(e.target.value)} />
      <textarea className="foundation-form w-full min-h-[60px]" placeholder="メモ (前提として知っておいてほしいこと)"
        value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="flex items-center gap-3">
        <button type="button" className="px-3 py-1 rounded bg-accent text-white text-xs" onClick={() => void save()}>保存</button>
        {message && <span className={`text-xs ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</span>}
      </div>
    </section>
  );
}
